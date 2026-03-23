package `in`.decorom.mcp

import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL

/**
 * Thin HTTP client for the AI Dev MCP server at https://ai.decorom.in
 * All requests include the x-api-key header for authentication.
 */
class McpClient(
    private val baseUrl: String = McpSettings.DEFAULT_BASE_URL,
    private val apiKey:  String
) {

    private fun url(path: String) = URL("${baseUrl.trimEnd('/')}$path")

    /** Apply common auth + content-type headers to a connection. */
    private fun HttpURLConnection.applyHeaders(json: Boolean = false) {
        setRequestProperty("x-api-key", apiKey)
        if (json) setRequestProperty("Content-Type", "application/json")
    }

    // ── GET /health ────────────────────────────────────────────────────────────
    fun health(): Boolean = try {
        val conn = (url("/health").openConnection() as HttpURLConnection).apply {
            connectTimeout = 5_000
            readTimeout    = 5_000
            applyHeaders()
        }
        val ok = conn.responseCode in 200..299
        conn.disconnect()
        ok
    } catch (_: Exception) { false }

    // ── POST /run ──────────────────────────────────────────────────────────────
    /**
     * Enqueue a task on the server.
     * @param workspacePath  Absolute path on the SERVER machine (server derives project name).
     * @return job ID string
     */
    fun runTask(prompt: String, workspacePath: String): String {
        val conn = (url("/run").openConnection() as HttpURLConnection).apply {
            requestMethod  = "POST"
            doOutput       = true
            connectTimeout = 10_000
            readTimeout    = 15_000
            applyHeaders(json = true)
        }
        val body = JSONObject()
            .put("prompt", prompt)
            .put("path",   workspacePath)
            .toString()
        conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
        val response = conn.inputStream.bufferedReader(Charsets.UTF_8).readText()
        conn.disconnect()
        return JSONObject(response).getString("id")
    }

    // ── GET /status/:id ────────────────────────────────────────────────────────
    fun getStatus(jobId: String): JSONObject {
        val conn = (url("/status/$jobId").openConnection() as HttpURLConnection)
            .apply { applyHeaders() }
        val response = conn.inputStream.bufferedReader(Charsets.UTF_8).readText()
        conn.disconnect()
        return JSONObject(response)
    }

    // ── GET /diff/:id ──────────────────────────────────────────────────────────
    fun getDiff(jobId: String): JSONObject {
        val conn = (url("/diff/$jobId").openConnection() as HttpURLConnection)
            .apply { applyHeaders() }
        val response = conn.inputStream.bufferedReader(Charsets.UTF_8).readText()
        conn.disconnect()
        return JSONObject(response)
    }

    // ── POST /revert/:id ───────────────────────────────────────────────────────
    fun revert(jobId: String, hard: Boolean = false): JSONObject {
        val qs   = if (hard) "?hard=true" else ""
        val conn = (url("/revert/$jobId$qs").openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput      = true
            applyHeaders(json = true)
        }
        conn.outputStream.use { it.write("{}".toByteArray(Charsets.UTF_8)) }
        val response = conn.inputStream.bufferedReader(Charsets.UTF_8).readText()
        conn.disconnect()
        return JSONObject(response)
    }

    // ── GET /jobs ──────────────────────────────────────────────────────────────
    fun listJobs(): String {
        val conn = (url("/jobs").openConnection() as HttpURLConnection)
            .apply { applyHeaders() }
        val response = conn.inputStream.bufferedReader(Charsets.UTF_8).readText()
        conn.disconnect()
        return response
    }

    // ── GET /stream/:id (SSE) ──────────────────────────────────────────────────
    /**
     * Blocks on a background thread until the stream closes.
     * @param onEvent  called for every SSE event with (eventName, parsedData).
     */
    fun stream(jobId: String, onEvent: (event: String, data: JSONObject?) -> Unit) {
        val conn = (url("/stream/$jobId").openConnection() as HttpURLConnection).apply {
            connectTimeout = 10_000
            readTimeout    = 0          // stream is long-lived
            applyHeaders()
            setRequestProperty("Accept", "text/event-stream")
        }
        val reader = BufferedReader(InputStreamReader(conn.inputStream, Charsets.UTF_8))
        var eventName = "message"
        var dataLine  = ""
        reader.useLines { lines ->
            for (line in lines) {
                when {
                    line.startsWith("event:") -> eventName = line.removePrefix("event:").trim()
                    line.startsWith("data:")  -> dataLine  = line.removePrefix("data:").trim()
                    line.isEmpty() && dataLine.isNotEmpty() -> {
                        val parsed = runCatching { JSONObject(dataLine) }.getOrNull()
                        onEvent(eventName, parsed)
                        eventName = "message"
                        dataLine  = ""
                    }
                }
            }
        }
        conn.disconnect()
    }
}
