package in.decorom.mcp.client

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

class McpClient {
    private val client = OkHttpClient()
    private val baseUrl = "http://localhost:3001"

    fun streamCode(prompt: String, project: String, onChunk: (String) -> Unit) {
        val body = """
            {
              "prompt": "$prompt"
            }
        """.trimIndent()

        val request = Request.Builder()
            .url("$baseUrl/ai/stream")
            .post(body.toRequestBody("application/json".toMediaType()))
            .build()

        client.newCall(request).execute().use { response ->
            val source = response.body?.source() ?: return
            while (!source.exhausted()) {
                val line = source.readUtf8Line()
                if (line != null && line.startsWith("data:")) {
                    onChunk(line.removePrefix("data:").trim())
                }
            }
        }
    }
}
