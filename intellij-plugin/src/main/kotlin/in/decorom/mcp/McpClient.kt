package `in`.decorom.mcp

import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * HTTP client for the AI Dev MCP server.
 *
 * Two transport modes:
 *
 *  1. REST API  — POST /run, GET /stream/:id, GET /diff/:id, POST /revert/:id
 *                 Used by the sidebar panel for job lifecycle.
 *
 *  2. MCP Streamable HTTP — POST /mcp
 *                 Stateless JSON-RPC over a single endpoint.
 *                 Sends the MCP `tools/call` envelope and returns the result.
 *                 This is the production-correct transport for IDE → MCP server.
 *
 * Auth: every request sends `x-api-key` header.
 * Project: NEVER sent by the client. Server derives it from the registered
 *          project name looked up via `project.name` on the IntelliJ side.
 */
class McpClient(private val baseUrl: String, private val apiKey: String) {

    // ══════════════════════════════════════════════════════════════════════════
    // MCP Streamable HTTP transport  (POST /mcp)
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * Call any MCP tool by name via the Streamable HTTP transport.
     * Returns the full JSON-RPC response object.
     *
     * Example:
     *   callMcpTool("project_scan", mapOf("project" to "myapp"))
     */
    fun callMcpTool(toolName: String, args: Map<String, Any> = emptyMap()): JSONObject {
        val argsJson = JSONObject(args)
        val envelope = JSONObject()
            .put("jsonrpc", "2.0")
            .put("id", System.currentTimeMillis())
            .put("method", "tools/call")
            .put("params", JSONObject()
                .put("name", toolName)
                .put("arguments", argsJson)
            )

        val conn = open("POST", "/mcp", timeout = 60_000)
        conn.setRequestProperty("Accept", "application/json, text/event-stream")
        conn.outputStream.use { it.write(envelope.toString().toByteArray()) }

        val body = conn.readBody()
        conn.disconnect()
        return JSONObject(body)
    }

    /**
     * Fetch the list of tools available on the server via MCP `tools/list`.
     */
    fun listMcpTools(): JSONObject {
        val envelope = JSONObject()
            .put("jsonrpc", "2.0")
            .put("id", System.currentTimeMillis())
            .put("method", "tools/list")
            .put("params", JSONObject())

        val conn = open("POST", "/mcp", timeout = 15_000)
        conn.setRequestProperty("Accept", "application/json")
        conn.outputStream.use { it.write(envelope.toString().toByteArray()) }

        val body = conn.readBody()
        conn.disconnect()
        return JSONObject(body)
    }

    // ══════════════════════════════════════════════════════════════════════════
    // REST job API  (/run, /stream, /diff, /revert)
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * Submit a prompt to the agent job queue.
     *
     * @param prompt      natural-language instruction
     * @param projectName registered project name from IntelliJ's project.name
     * @return job ID string
     */
    fun runTask(prompt: String, projectName: String): String {
        val conn = open("POST", "/run", timeout = 15_000)
        val body = JSONObject()
            .put("prompt", prompt)
            .put("project", projectName)  // registered name only — no paths
            .toString()
        conn.outputStream.use { it.write(body.toByteArray()) }
        val response = conn.readBody()
        conn.disconnect()
        return JSONObject(response).getString("id")
    }

    // ── GET /status/:id ───────────────────────────────────────────────────────
    fun getStatus(jobId: String): JSONObject {
        val conn = open("GET", "/status/$jobId")
        val response = conn.readBody(); conn.disconnect()
        return JSONObject(response)
    }

    // ── GET /diff/:id ─────────────────────────────────────────────────────────
    fun getDiff(jobId: String): JSONObject {
        val conn = open("GET", "/diff/$jobId")
        val response = conn.readBody(); conn.disconnect()
        return JSONObject(response)
    }

    // ── POST /revert/:id ──────────────────────────────────────────────────────
    fun revert(jobId: String, hard: Boolean = false): JSONObject {
        val qs   = if (hard) "?hard=true" else ""
        val conn = open("POST", "/revert/$jobId$qs")
        conn.outputStream.use { it.write("{}".toByteArray()) }
        val response = conn.readBody(); conn.disconnect()
        return JSONObject(response)
    }

    // ── GET /jobs ─────────────────────────────────────────────────────────────
    fun listJobs(): String {
        val conn = open("GET", "/jobs")
        val response = conn.readBody(); conn.disconnect()
        return response
    }

    // ── GET /health ───────────────────────────────────────────────────────────
    /** Returns true if the server is reachable and healthy. */
    fun health(): Boolean = try {
        val conn = open("GET", "/health", connectTimeout = 4_000, timeout = 4_000)
        val ok = conn.responseCode in 200..299
        conn.disconnect(); ok
    } catch (_: Exception) { false }

    // ── GET /stream/:id  (SSE) ────────────────────────────────────────────────
    /**
     * Open a Server-Sent Events stream for a running job.
     * Blocks the calling thread until the stream closes — call on a background thread.
     *
     * @param onEvent  callback(eventName, jsonData?) called for each SSE event
     */
    fun stream(jobId: String, onEvent: (event: String, data: JSONObject?) -> Unit) {
        val conn = open("GET", "/stream/$jobId", timeout = 0)
        conn.setRequestProperty("Accept", "text/event-stream")

        val reader = BufferedReader(InputStreamReader(conn.inputStream))
        var eventName = "message"
        var dataLine  = ""

        reader.useLines { lines ->
            for (line in lines) {
                when {
                    line.startsWith("event:") -> eventName = line.removePrefix("event:").trim()
                    line.startsWith("data:")  -> dataLine  = line.removePrefix("data:").trim()
                    line.startsWith(":")      -> Unit   // SSE heartbeat comment — ignore
                    line.isEmpty() && dataLine.isNotEmpty() -> {
                        val parsed = runCatching { JSONObject(dataLine) }.getOrNull()
                        onEvent(eventName, parsed)
                        eventName = "message"; dataLine = ""
                    }
                }
            }
        }
        conn.disconnect()
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Workspace Sync  (zip → upload → run → download)
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * Upload a zip of the local workspace to POST /workspace/upload.
     * Returns the remote upload ID.
     */
    fun uploadWorkspace(zipBytes: ByteArray, projectName: String): String {
        val boundary = "----McpBoundary${System.currentTimeMillis()}"
        val conn     = open("POST", "/workspace/upload", timeout = 120_000)
        conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")

        conn.outputStream.use { out ->
            writePart(out, boundary, "project", projectName.toByteArray(), "text/plain")
            writePart(out, boundary, "file", zipBytes, "application/zip", "workspace.zip")
            out.write("\r\n--$boundary--\r\n".toByteArray())
        }

        val response = conn.readBody(); conn.disconnect()
        return JSONObject(response).getString("uploadId")
    }

    /**
     * Download the result zip from GET /workspace/download/:id.
     */
    fun downloadWorkspace(uploadId: String): ByteArray {
        val conn = open("GET", "/workspace/download/$uploadId", timeout = 120_000)
        val bytes = conn.inputStream.readBytes()
        conn.disconnect()
        return bytes
    }

    // ── helpers ───────────────────────────────────────────────────────────────
    private fun open(
        method: String, path: String,
        connectTimeout: Int = 10_000, timeout: Int = 30_000
    ): HttpURLConnection {
        val conn = URL("$baseUrl$path").openConnection() as HttpURLConnection
        conn.requestMethod   = method
        conn.connectTimeout  = connectTimeout
        conn.readTimeout     = timeout
        conn.setRequestProperty("x-api-key",      apiKey)
        conn.setRequestProperty("Content-Type",   "application/json")
        if (method in setOf("POST", "PUT", "PATCH")) conn.doOutput = true
        return conn
    }

    private fun HttpURLConnection.readBody(): String =
        try { inputStream.bufferedReader().readText() }
        catch (_: Exception) { errorStream?.bufferedReader()?.readText() ?: "{}" }

    private fun writePart(
        out: OutputStream, boundary: String, name: String,
        data: ByteArray, contentType: String, filename: String? = null
    ) {
        val disposition = if (filename != null)
            "Content-Disposition: form-data; name=\"$name\"; filename=\"$filename\""
        else
            "Content-Disposition: form-data; name=\"$name\""
        out.write("\r\n--$boundary\r\n".toByteArray())
        out.write("$disposition\r\n".toByteArray())
        out.write("Content-Type: $contentType\r\n\r\n".toByteArray())
        out.write(data)
    }
}
