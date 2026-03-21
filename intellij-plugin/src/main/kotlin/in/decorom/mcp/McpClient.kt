package `in`.decorom.mcp

import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL

class McpClient(private val baseUrl: String, private val apiKey: String) {

    private fun conn(path: String): HttpURLConnection =
        (URL("$baseUrl$path").openConnection() as HttpURLConnection).apply {
            setRequestProperty("x-api-key", apiKey)
            setRequestProperty("Content-Type", "application/json")
            connectTimeout = 10_000
        }

    /** POST /run — returns job ID. Only prompt + path sent — server derives project name. */
    fun runTask(prompt: String, projectPath: String): String {
        val c = conn("/run").apply {
            requestMethod = "POST"
            doOutput      = true
            readTimeout   = 15_000
        }
        val body = JSONObject().put("prompt", prompt).put("path", projectPath)
        c.outputStream.use { it.write(body.toString().toByteArray()) }
        val resp = c.inputStream.bufferedReader().readText()
        c.disconnect()
        return JSONObject(resp).getString("id")
    }

    /** GET /status/:id */
    fun getStatus(jobId: String): JSONObject {
        val c = conn("/status/$jobId")
        val resp = c.inputStream.bufferedReader().readText()
        c.disconnect()
        return JSONObject(resp)
    }

    /** GET /stream/:id — SSE. Blocks until stream closes. Call on a background thread. */
    fun stream(jobId: String, onEvent: (event: String, data: JSONObject?) -> Unit) {
        val c = conn("/stream/$jobId").apply {
            setRequestProperty("Accept", "text/event-stream")
            readTimeout = 0
        }
        val reader = BufferedReader(InputStreamReader(c.inputStream))
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
        c.disconnect()
    }
}
