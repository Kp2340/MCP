package `in`.decorom.mcp

import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL

/**
 * Thin HTTP client for the AI Dev MCP REST API.
 * Uses java.net.HttpURLConnection — no external libraries needed.
 */
class McpClient(private val baseUrl: String, private val apiKey: String) {

    // ── POST /run ─────────────────────────────────────────────────────────────
    fun runTask(prompt: String, project: String): String {
        val conn = open("POST", "/run", timeout = 15_000)
        val body = JSONObject().put("prompt", prompt).put("project", project).toString()
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
    fun health(): Boolean = try {
        val conn = open("GET", "/health", connectTimeout = 4_000, timeout = 4_000)
        val ok = conn.responseCode in 200..299
        conn.disconnect(); ok
    } catch (_: Exception) { false }

    // ── GET /stream/:id  (SSE) ────────────────────────────────────────────────
    // Blocks the calling thread. Run on a background thread.
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
                    line.startsWith(":")      -> Unit  // heartbeat comment — ignore
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

    // ── helpers ───────────────────────────────────────────────────────────────
    private fun open(
        method: String, path: String,
        connectTimeout: Int = 10_000, timeout: Int = 30_000
    ): HttpURLConnection {
        val conn = URL("$baseUrl$path").openConnection() as HttpURLConnection
        conn.requestMethod  = method
        conn.connectTimeout = connectTimeout
        conn.readTimeout    = timeout
        conn.setRequestProperty("x-api-key", apiKey)
        conn.setRequestProperty("Content-Type", "application/json")
        if (method == "POST" || method == "PUT") conn.doOutput = true
        return conn
    }

    private fun HttpURLConnection.readBody(): String =
        try { inputStream.bufferedReader().readText() }
        catch (_: Exception) { errorStream?.bufferedReader()?.readText() ?: "" }
}
