package `in`.decorom.mcp

import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL

class McpClient(private val baseUrl: String, private val apiKey: String) {

    private fun conn(urlStr: String, method: String = "GET", body: String? = null): HttpURLConnection {
        val conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
            requestMethod  = method
            connectTimeout = 10_000
            readTimeout    = if (body != null) 15_000 else 0
            setRequestProperty("x-api-key", apiKey)
            if (body != null) {
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                outputStream.use { it.write(body.toByteArray()) }
            }
        }
        return conn
    }

    private fun read(c: HttpURLConnection): String {
        val stream = if (c.responseCode in 200..299) c.inputStream else c.errorStream
        return stream.bufferedReader().use { it.readText() }.also { c.disconnect() }
    }

    /** POST /run — enqueue a task. Returns job id. */
    fun runTask(prompt: String, workspacePath: String): String {
        val body = JSONObject().put("prompt", prompt).put("path", workspacePath).toString()
        val c    = conn("$baseUrl/run", "POST", body)
        val resp = read(c)
        if (c.responseCode !in 200..299) throw RuntimeException("POST /run → ${c.responseCode}: $resp")
        return JSONObject(resp).getString("id")
    }

    /** GET /status/:id */
    fun getStatus(jobId: String): JSONObject {
        val c = conn("$baseUrl/status/$jobId")
        return JSONObject(read(c))
    }

    /** GET /diff/:id */
    fun getDiff(jobId: String): JSONObject {
        val c = conn("$baseUrl/diff/$jobId")
        return JSONObject(read(c))
    }

    /** POST /revert/:id — safe (default) or hard */
    fun revert(jobId: String, hard: Boolean = false): JSONObject {
        val qs = if (hard) "?hard=true" else ""
        val c  = conn("$baseUrl/revert/$jobId$qs", "POST", "{}")
        return JSONObject(read(c))
    }

    /** GET /jobs */
    fun listJobs(): String {
        return read(conn("$baseUrl/jobs"))
    }

    /** GET /health → true if server is up */
    fun health(): Boolean = try {
        val c = conn("$baseUrl/health").apply { connectTimeout = 4_000; readTimeout = 4_000 }
        val ok = c.responseCode in 200..299
        c.disconnect()
        ok
    } catch (_: Exception) { false }

    // ── Workspace sync ────────────────────────────────────────────────────────

    /** POST /workspace/push?project=<name>  — upload zip bytes */
    fun pushWorkspace(projectName: String, zipBytes: ByteArray): JSONObject {
        val url  = "$baseUrl/workspace/push?project=${java.net.URLEncoder.encode(projectName, "UTF-8")}"
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput      = true
            connectTimeout = 15_000
            readTimeout    = 120_000
            setRequestProperty("x-api-key", apiKey)
            setRequestProperty("Content-Type", "application/octet-stream")
            outputStream.use { it.write(zipBytes) }
        }
        val body = read(conn)
        if (conn.responseCode !in 200..299) throw RuntimeException("Push failed ${conn.responseCode}: $body")
        return JSONObject(body)
    }

    /** GET /workspace/pull/<name>  — download changed-files zip */
    fun pullWorkspace(projectName: String): ByteArray {
        val url  = "$baseUrl/workspace/pull/${java.net.URLEncoder.encode(projectName, "UTF-8")}"
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15_000
            readTimeout    = 120_000
            setRequestProperty("x-api-key", apiKey)
        }
        if (conn.responseCode !in 200..299) {
            val err = conn.errorStream?.bufferedReader()?.readText() ?: ""
            conn.disconnect()
            throw RuntimeException("Pull failed ${conn.responseCode}: $err")
        }
        val bytes = conn.inputStream.use { it.readBytes() }
        conn.disconnect()
        return bytes
    }

    // ── SSE streaming ─────────────────────────────────────────────────────────
    /** Blocks on background thread; calls onEvent for each SSE event. */
    fun stream(jobId: String, onEvent: (event: String, data: JSONObject?) -> Unit) {
        val conn = (URL("$baseUrl/stream/$jobId").openConnection() as HttpURLConnection).apply {
            setRequestProperty("x-api-key", apiKey)
            setRequestProperty("Accept", "text/event-stream")
            connectTimeout = 10_000
            readTimeout    = 0  // long-lived stream
        }
        val reader    = BufferedReader(InputStreamReader(conn.inputStream))
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
