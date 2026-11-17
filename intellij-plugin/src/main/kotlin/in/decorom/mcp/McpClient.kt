package `in`.decorom.mcp

import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL

class McpClient(private val baseUrl: String, private val apiKey: String) {

    private fun openConn(urlPath: String, method: String = "GET", hasBody: Boolean = false): HttpURLConnection {
        val conn = URL("${baseUrl.trimEnd('/')}$urlPath").openConnection() as HttpURLConnection
        conn.requestMethod  = method
        conn.connectTimeout = 10_000
        conn.readTimeout    = 15_000
        conn.setRequestProperty("x-api-key", apiKey)
        conn.setRequestProperty("Content-Type", "application/json")
        if (hasBody) conn.doOutput = true
        return conn
    }

    private fun readText(conn: HttpURLConnection): String {
        return try {
            conn.inputStream.bufferedReader().use { it.readText() }
        } catch (e: Exception) {
            conn.errorStream?.bufferedReader()?.use { it.readText() } ?: e.message ?: "unknown error"
        } finally {
            conn.disconnect()
        }
    }

    private fun writeBody(conn: HttpURLConnection, body: String) {
        conn.outputStream.use { it: OutputStream -> it.write(body.toByteArray(Charsets.UTF_8)) }
    }

    // ── POST /run ─────────────────────────────────────────────────────────────
    // FIX v1.7.0: send `project` (registry name) NOT `path`.
    // Server /run expects { project, prompt } — path was never a valid field.
    fun runTask(prompt: String, project: String): String {
        val conn = openConn("/run", "POST", hasBody = true)
        writeBody(conn, JSONObject().put("prompt", prompt).put("project", project).toString())
        val response = readText(conn)
        return JSONObject(response).getString("id")
    }

    // ── GET /status/:id ───────────────────────────────────────────────────────
    fun getStatus(jobId: String): JSONObject {
        return JSONObject(readText(openConn("/status/$jobId")))
    }

    // ── GET /diff/:id ─────────────────────────────────────────────────────────
    fun getDiff(jobId: String): JSONObject {
        return JSONObject(readText(openConn("/diff/$jobId")))
    }

    // ── POST /revert/:id ──────────────────────────────────────────────────────
    fun revert(jobId: String, hard: Boolean = false): JSONObject {
        val qs   = if (hard) "?hard=true" else ""
        val conn = openConn("/revert/$jobId$qs", "POST", hasBody = true)
        writeBody(conn, "{}")
        return JSONObject(readText(conn))
    }

    // ── GET /jobs ─────────────────────────────────────────────────────────────
    fun listJobs(): String = readText(openConn("/jobs"))

    // ── GET /health ───────────────────────────────────────────────────────────
    fun health(): Boolean = try {
        val conn = openConn("/health").also { it.connectTimeout = 4_000; it.readTimeout = 4_000 }
        val ok   = conn.responseCode in 200..299
        conn.disconnect()
        ok
    } catch (_: Exception) { false }

    // ── Workspace push/pull ───────────────────────────────────────────────────
    fun pushWorkspace(projectName: String, zipBytes: ByteArray): JSONObject {
        val conn = URL("${baseUrl.trimEnd('/')}/workspace/push?project=${encode(projectName)}").openConnection() as HttpURLConnection
        conn.requestMethod = "POST"
        conn.doOutput      = true
        conn.connectTimeout = 30_000
        conn.readTimeout    = 120_000
        conn.setRequestProperty("x-api-key", apiKey)
        conn.setRequestProperty("Content-Type", "application/octet-stream")
        conn.outputStream.use { it.write(zipBytes) }
        return JSONObject(readText(conn))
    }

    fun pullWorkspace(projectName: String): ByteArray {
        val conn = URL("${baseUrl.trimEnd('/')}/workspace/pull/${encode(projectName)}").openConnection() as HttpURLConnection
        conn.connectTimeout = 30_000
        conn.readTimeout    = 120_000
        conn.setRequestProperty("x-api-key", apiKey)
        return conn.inputStream.use { it.readBytes() }.also { conn.disconnect() }
    }

    // ── GET /stream/:id  (SSE) ────────────────────────────────────────────────
    // Must be called from a background thread — blocks until stream closes.
    fun stream(jobId: String, onEvent: (event: String, data: JSONObject?) -> Unit) {
        val conn = URL("${baseUrl.trimEnd('/')}/stream/$jobId").openConnection() as HttpURLConnection
        conn.setRequestProperty("x-api-key", apiKey)
        conn.setRequestProperty("Accept", "text/event-stream")
        conn.connectTimeout = 10_000
        conn.readTimeout    = 0   // no timeout — stream is long-lived

        val reader    = BufferedReader(InputStreamReader(conn.inputStream, Charsets.UTF_8))
        var eventName = "message"
        var dataLine  = ""

        // FIX v1.7.0: strip \r from lines so CRLF SSE streams work correctly on all OS
        reader.useLines { lines ->
            for (rawLine in lines) {
                val line = rawLine.trimEnd('\r')
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

    private fun encode(s: String) = java.net.URLEncoder.encode(s, "UTF-8")
}
