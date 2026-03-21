# IntelliJ Plugin — Architecture Guide

## Overview

The IntelliJ plugin is a **Kotlin Tool Window plugin** that:
1. Provides a sidebar panel for submitting prompts
2. Calls `POST /run` to enqueue tasks
3. Streams logs from `GET /stream/:id`
4. Injects the current file path and selected code into every request

---

## Plugin Structure

```
intellij-plugin/
├── src/main/
│   ├── kotlin/in/decorom/mcp/
│   │   ├── McpPlugin.kt           ← Plugin entry point
│   │   ├── McpToolWindowFactory.kt ← Creates the sidebar panel
│   │   ├── McpToolWindow.kt       ← UI panel (JPanel, JTextField, JTextArea)
│   │   ├── McpClient.kt           ← HTTP client (OkHttp or built-in HttpURLConnection)
│   │   ├── McpSettings.kt         ← Persistent settings (baseUrl, apiKey, project)
│   │   └── McpSettingsComponent.kt ← Settings UI
│   └── resources/
│       ├── META-INF/plugin.xml    ← Plugin manifest
│       └── icons/mcp.svg          ← Sidebar icon
└── build.gradle.kts
```

---

## plugin.xml (manifest)

```xml
<idea-plugin>
  <id>in.decorom.mcp</id>
  <name>AI Dev MCP</name>
  <vendor>Kp2340</vendor>
  <description>Connect to your private MCP coding agent</description>

  <depends>com.intellij.modules.platform</depends>

  <extensions defaultExtensionNs="com.intellij">
    <!-- Tool window sidebar panel -->
    <toolWindow id="AI Dev MCP"
                secondary="false"
                anchor="right"
                factoryClass="in.decorom.mcp.McpToolWindowFactory"
                icon="/icons/mcp.svg"/>

    <!-- Persistent settings page -->
    <applicationConfigurable
        parentId="tools"
        instance="in.decorom.mcp.McpSettingsComponent"
        displayName="AI Dev MCP"/>

    <!-- Persistent state storage -->
    <applicationService
        serviceImplementation="in.decorom.mcp.McpSettings"/>
  </extensions>

  <actions>
    <action id="McpRunPrompt"
            class="in.decorom.mcp.RunPromptAction"
            text="MCP: Run AI Prompt"
            description="Send prompt to your MCP coding agent">
      <keyboard-shortcut keymap="$default" first-keystroke="ctrl shift M"/>
    </action>
  </actions>
</idea-plugin>
```

---

## McpClient.kt — HTTP Client

```kotlin
package in.decorom.mcp

import java.net.HttpURLConnection
import java.net.URL
import java.io.BufferedReader
import java.io.InputStreamReader
import org.json.JSONObject

class McpClient(private val baseUrl: String, private val apiKey: String) {

    // ── POST /run ──────────────────────────────────────────────────────────────
    fun runTask(prompt: String, project: String): String {
        val url = URL("$baseUrl/run")
        val conn = url.openConnection() as HttpURLConnection
        conn.requestMethod  = "POST"
        conn.doOutput       = true
        conn.connectTimeout = 10_000
        conn.readTimeout    = 15_000
        conn.setRequestProperty("Content-Type", "application/json")
        conn.setRequestProperty("x-api-key", apiKey)

        val body = JSONObject()
            .put("prompt",  prompt)
            .put("project", project)
            .toString()

        conn.outputStream.use { it.write(body.toByteArray()) }

        val response = conn.inputStream.bufferedReader().readText()
        conn.disconnect()

        return JSONObject(response).getString("id")
    }

    // ── GET /status/:id ────────────────────────────────────────────────────────
    fun getStatus(jobId: String): JSONObject {
        val url  = URL("$baseUrl/status/$jobId")
        val conn = url.openConnection() as HttpURLConnection
        conn.setRequestProperty("x-api-key", apiKey)
        val response = conn.inputStream.bufferedReader().readText()
        conn.disconnect()
        return JSONObject(response)
    }

    // ── GET /stream/:id  (SSE) ─────────────────────────────────────────────────
    // Call this on a background thread — it blocks until the stream closes.
    fun stream(jobId: String, onEvent: (event: String, data: JSONObject?) -> Unit) {
        val url  = URL("$baseUrl/stream/$jobId")
        val conn = url.openConnection() as HttpURLConnection
        conn.setRequestProperty("x-api-key", apiKey)
        conn.setRequestProperty("Accept", "text/event-stream")
        conn.connectTimeout = 10_000
        conn.readTimeout    = 0   // no timeout — stream is long-lived

        val reader = BufferedReader(InputStreamReader(conn.inputStream))
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
                        // Reset for next event block
                        eventName = "message"
                        dataLine  = ""
                    }
                }
            }
        }
        conn.disconnect()
    }
}
```

---

## McpToolWindow.kt — UI Panel

```kotlin
package in.decorom.mcp

import com.intellij.openapi.editor.Editor
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import java.awt.BorderLayout
import java.awt.Dimension
import javax.swing.*

class McpToolWindow(private val project: Project) {

    val panel: JPanel = JPanel(BorderLayout(8, 8))

    private val promptField  = JTextField()
    private val projectField = JTextField()
    private val runButton    = JButton("▶  Run")
    private val logArea      = JTextArea().apply {
        isEditable = false
        font = java.awt.Font("Monospaced", java.awt.Font.PLAIN, 12)
        lineWrap = true
    }
    private val scrollPane = JScrollPane(logArea)

    init {
        // ── Top form ──────────────────────────────────────────────────────────
        val form = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)

            add(JLabel("Project key:"))
            add(projectField.apply { preferredSize = Dimension(300, 28) })
            add(Box.createVerticalStrut(4))
            add(JLabel("Prompt:"))
            add(promptField.apply { preferredSize = Dimension(300, 28) })
            add(Box.createVerticalStrut(6))
            add(runButton)
        }

        panel.add(form, BorderLayout.NORTH)
        panel.add(scrollPane, BorderLayout.CENTER)

        // Auto-fill project from settings
        val settings = McpSettings.instance
        projectField.text = settings.defaultProject

        // ── Run button ────────────────────────────────────────────────────────
        runButton.addActionListener { onRun() }
    }

    private fun onRun() {
        val prompt  = promptField.text.trim()
        val proj    = projectField.text.trim()
        val settings = McpSettings.instance

        if (settings.baseUrl.isEmpty() || settings.apiKey.isEmpty()) {
            Messages.showErrorDialog(project, "Configure baseUrl and apiKey in Settings → Tools → AI Dev MCP", "MCP Not Configured")
            return
        }
        if (prompt.isEmpty() || proj.isEmpty()) {
            Messages.showWarningDialog(project, "Enter both a project key and a prompt.", "MCP")
            return
        }

        // Inject editor context
        val fullPrompt = buildPromptWithContext(prompt)

        logArea.text = ""
        runButton.isEnabled = false
        log("▶ Running: \"${fullPrompt.take(80)}\" on [$proj]")

        // Run on background thread to avoid blocking the EDT
        Thread {
            try {
                val client = McpClient(settings.baseUrl, settings.apiKey)
                val jobId  = client.runTask(fullPrompt, proj)
                log("  Job ID: $jobId")
                log("─".repeat(50))

                client.stream(jobId) { event, data ->
                    SwingUtilities.invokeLater {
                        when (event) {
                            "completed" -> {
                                log("✔  Completed: ${data?.toString()}")
                                runButton.isEnabled = true
                            }
                            "failed"    -> {
                                log("✘  Failed: ${data?.toString()}")
                                runButton.isEnabled = true
                            }
                            else -> {
                                val logMsg = data?.optString("log") ?: data?.toString() ?: ""
                                val step   = data?.optInt("step", -1).takeIf { it != -1 }
                                log("  ${if (step != null) "[$step] " else ""}$logMsg")
                            }
                        }
                    }
                }
            } catch (e: Exception) {
                SwingUtilities.invokeLater {
                    log("✘  Error: ${e.message}")
                    runButton.isEnabled = true
                }
            }
        }.start()
    }

    private fun buildPromptWithContext(prompt: String): String {
        val editor: Editor? = FileEditorManager.getInstance(project).selectedTextEditor
        val selectedText = editor?.selectionModel?.selectedText
        val filePath     = editor?.document?.let {
            com.intellij.openapi.fileEditor.FileDocumentManager.getInstance().getFile(it)?.path
        }

        return if (!selectedText.isNullOrBlank() && filePath != null) {
            "[File: $filePath]\n```\n$selectedText\n```\n\n$prompt"
        } else {
            prompt
        }
    }

    private fun log(msg: String) {
        SwingUtilities.invokeLater {
            logArea.append("$msg\n")
            logArea.caretPosition = logArea.document.length
        }
    }
}
```

---

## McpSettings.kt — Persistent State

```kotlin
package in.decorom.mcp

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage

@State(name = "McpSettings", storages = [Storage("McpSettings.xml")])
class McpSettings : PersistentStateComponent<McpSettings.State> {

    data class State(
        var baseUrl:        String = "",
        var apiKey:         String = "",
        var defaultProject: String = ""
    )

    private var _state = State()

    override fun getState()              = _state
    override fun loadState(s: State)     { _state = s }

    var baseUrl:        String get() = _state.baseUrl;        set(v) { _state.baseUrl        = v }
    var apiKey:         String get() = _state.apiKey;         set(v) { _state.apiKey         = v }
    var defaultProject: String get() = _state.defaultProject; set(v) { _state.defaultProject = v }

    companion object {
        val instance: McpSettings
            get() = ApplicationManager.getApplication().getService(McpSettings::class.java)
    }
}
```

---

## build.gradle.kts

```kotlin
plugins {
    id("org.jetbrains.intellij") version "1.17.0"
    kotlin("jvm") version "1.9.22"
}

group   = "in.decorom"
version = "1.0.0"

repositories { mavenCentral() }

dependencies {
    implementation("org.json:json:20240303")   // lightweight JSON — no Jackson needed
}

intellij {
    version.set("2024.1")
    type.set("IC")           // IntelliJ IDEA Community
    plugins.set(listOf())
}

tasks {
    buildSearchableOptions { enabled = false }
    patchPluginXml {
        sinceBuild.set("231")
        untilBuild.set("")
    }
    signPlugin {
        certificateChain.set(System.getenv("CERTIFICATE_CHAIN") ?: "")
        privateKey.set(System.getenv("PRIVATE_KEY") ?: "")
        password.set(System.getenv("PRIVATE_KEY_PASSWORD") ?: "")
    }
    publishPlugin {
        token.set(System.getenv("PUBLISH_TOKEN") ?: "")
    }
}
```

---

## Distribution (internal)

For internal team distribution, **skip JetBrains Marketplace**:

```bash
./gradlew buildPlugin
# Produces: build/distributions/aidev-mcp-1.0.0.zip
```

Teammates install via:
**Settings → Plugins → ⚙ → Install Plugin from Disk…** → select the `.zip`

---

## Key Integration Points

| What the plugin injects | How |
|---|---|
| Current file path | `FileEditorManager.selectedTextEditor.document` |
| Selected code | `editor.selectionModel.selectedText` |
| Project key | User input / saved in `McpSettings` |
| API key | Stored in `McpSettings` (Settings → Tools → AI Dev MCP) |
