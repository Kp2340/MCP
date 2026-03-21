package `in`.decorom.mcp

import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.Font
import javax.swing.*

class McpToolWindow(private val project: Project) {

    val panel = JPanel(BorderLayout(8, 8))

    private val promptField  = JTextField()
    private val runButton    = JButton("▶  Run")
    private val clearButton  = JButton("Clear")
    private val logArea      = JTextArea().apply {
        isEditable    = false
        font          = Font("Monospaced", Font.PLAIN, 12)
        lineWrap      = true
        wrapStyleWord = true
    }

    init {
        val form = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            border = BorderFactory.createEmptyBorder(8, 8, 4, 8)
            add(JLabel("Prompt:"))
            add(promptField.apply { maximumSize = Dimension(Int.MAX_VALUE, 28) })
            add(Box.createVerticalStrut(6))
            add(JPanel().apply {
                layout = BoxLayout(this, BoxLayout.X_AXIS)
                add(runButton)
                add(Box.createHorizontalStrut(6))
                add(clearButton)
            })
        }

        panel.add(form, BorderLayout.NORTH)
        panel.add(JScrollPane(logArea), BorderLayout.CENTER)

        projectField.text = McpSettings.instance.defaultProject.ifBlank {
            project.name.lowercase().replace(Regex("[^a-z0-9\\-_]"), "-")
        }

        runButton.addActionListener   { onRun() }
        clearButton.addActionListener { logArea.text = "" }
        promptField.addActionListener { onRun() }
    }

    private fun onRun() {
        val settings = McpSettings.instance
        if (settings.baseUrl.isEmpty() || settings.apiKey.isEmpty()) {
            Messages.showErrorDialog(project,
                "Configure Server URL and API Key in Settings → Tools → AI Dev MCP",
                "AI Dev MCP Not Configured")
            return
        }
        val proj   = projectField.text.trim()
        val prompt = promptField.text.trim()
        if (proj.isEmpty() || prompt.isEmpty()) {
            Messages.showWarningDialog(project, "Enter both a project name and a prompt.", "AI Dev MCP")
            return
        }

        val fullPrompt = injectEditorContext(prompt)
        val projPath   = project.basePath

        runButton.isEnabled = false
        promptField.text    = ""
        log("▶  Running: \"${fullPrompt.take(80)}${if (fullPrompt.length > 80) "…" else ""}\" on [$proj]")
        if (projPath != null) log("   Path: $projPath")
        log("─".repeat(52))

        Thread {
            try {
                val client = McpClient(settings.baseUrl, settings.apiKey)
                val jobId  = client.runTask(fullPrompt, proj, projPath)
                log("   Job ID : $jobId")
                log("   Stream : ${settings.baseUrl}/stream/$jobId")
                log("─".repeat(52))

                var stepCount = 0
                client.stream(jobId) { event, data ->
                    SwingUtilities.invokeLater {
                        when (event) {
                            "completed" -> { log("─".repeat(52)); log("✔  Completed: ${data?.toString() ?: ""}"); runButton.isEnabled = true }
                            "failed"    -> { log("─".repeat(52)); log("✘  Failed: ${data?.toString() ?: ""}");    runButton.isEnabled = true }
                            "queued"    -> log("   Queued at position ${data?.optInt("position", 0)}")
                            "started"   -> log("   Agent started")
                            "step"      -> { stepCount++; log("   [${data?.optInt("step", stepCount) ?: stepCount}] ${data?.optString("detail") ?: data?.toString() ?: ""}") }
                            else        -> { stepCount++; log("   ${data?.optString("log") ?: data?.optString("result") ?: data?.optString("status") ?: data?.toString() ?: ""}") }
                        }
                    }
                }
            } catch (e: Exception) {
                SwingUtilities.invokeLater { log("✘  Error: ${e.message}"); runButton.isEnabled = true }
            }
        }.start()
    }

    private fun injectEditorContext(prompt: String): String {
        val editor   = FileEditorManager.getInstance(project).selectedTextEditor ?: return prompt
        val selected = editor.selectionModel.selectedText ?: return prompt
        val path     = FileDocumentManager.getInstance().getFile(editor.document)?.path ?: "unknown"
        return "[File: $path]\n```\n$selected\n```\n\n$prompt"
    }

    private fun log(msg: String) {
        SwingUtilities.invokeLater {
            logArea.append("$msg\n")
            logArea.caretPosition = logArea.document.length
        }
    }
}
