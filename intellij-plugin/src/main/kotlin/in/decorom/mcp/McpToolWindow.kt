package `in`.decorom.mcp

import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.Font
import javax.swing.*

class McpToolWindow(private val project: Project) {

    val panel: JPanel = JPanel(BorderLayout(8, 8)).also { it.border = BorderFactory.createEmptyBorder(8, 8, 8, 8) }

    private val promptField  = JTextField()
    private val pathField    = JTextField()
    private val runButton    = JButton("▶  Run")
    private val clearButton  = JButton("Clear")
    private val logArea      = JTextArea().apply {
        isEditable = false
        font       = Font(Font.MONOSPACED, Font.PLAIN, 12)
        lineWrap   = true
        wrapStyleWord = true
    }
    private val scrollPane = JScrollPane(logArea)

    init {
        val settings = McpSettings.instance

        // ── Form ──────────────────────────────────────────────────────────────
        val form = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)

            add(JLabel("Server URL:"))
            add(JLabel(settings.baseUrl).apply {
                font = Font(Font.MONOSPACED, Font.PLAIN, 11)
                foreground = java.awt.Color(100, 200, 100)
            })
            add(Box.createVerticalStrut(4))

            add(JLabel("Workspace path (auto-detected):"))
            add(pathField.apply {
                preferredSize = Dimension(300, 28)
                text = project.basePath ?: settings.defaultProject
                isEditable = true
            })
            add(Box.createVerticalStrut(4))

            add(JLabel("Prompt:"))
            add(promptField.apply { preferredSize = Dimension(300, 28) })
            add(Box.createVerticalStrut(6))

            val btnRow = JPanel().apply {
                layout = BoxLayout(this, BoxLayout.X_AXIS)
                add(runButton)
                add(Box.createHorizontalStrut(8))
                add(clearButton)
            }
            add(btnRow)
        }

        panel.add(form, BorderLayout.NORTH)
        panel.add(scrollPane, BorderLayout.CENTER)

        // ── Health check on panel open ─────────────────────────────────────────
        Thread {
            if (settings.apiKey.isBlank()) {
                SwingUtilities.invokeLater { log("⚠ API key not set — go to Settings → Tools → AI Dev MCP") }
                return@Thread
            }
            val ok = try { McpClient(settings.baseUrl, settings.apiKey).health() } catch (_: Exception) { false }
            SwingUtilities.invokeLater {
                log(if (ok) "✓ Connected to ${settings.baseUrl}" else "⚠ Cannot reach ${settings.baseUrl} — check settings")
            }
        }.start()

        runButton.addActionListener   { onRun() }
        clearButton.addActionListener { logArea.text = "" }

        // Enter key submits prompt
        promptField.addActionListener { onRun() }
    }

    private fun log(msg: String) {
        val t = java.time.LocalTime.now().toString().take(8)
        logArea.append("[$t] $msg\n")
        logArea.caretPosition = logArea.document.length
    }

    private fun onRun() {
        val settings      = McpSettings.instance
        val prompt        = promptField.text.trim()
        val workspacePath = pathField.text.trim().ifEmpty { project.basePath ?: "" }

        if (settings.apiKey.isBlank()) {
            Messages.showErrorDialog(
                project,
                "API key is not set.\n\nGo to Settings → Tools → AI Dev MCP and enter your key for https://ai.decorom.in.",
                "MCP: API Key Required"
            )
            return
        }
        if (prompt.isEmpty()) {
            Messages.showWarningDialog(project, "Please enter a prompt.", "MCP")
            return
        }
        if (workspacePath.isEmpty()) {
            Messages.showWarningDialog(project, "Workspace path is empty — open a project folder first.", "MCP")
            return
        }

        val fullPrompt = enrichPrompt(prompt)
        logArea.text        = ""
        runButton.isEnabled = false
        log("▶ Prompt: \"${fullPrompt.take(80)}\"")
        log("  Path:   $workspacePath")
        log("  Server: ${settings.baseUrl}")

        Thread {
            try {
                val client = McpClient(settings.baseUrl, settings.apiKey)
                val jobId  = client.runTask(fullPrompt, workspacePath)
                SwingUtilities.invokeLater { log("  Job ID: $jobId") }

                client.stream(jobId) { event, data ->
                    SwingUtilities.invokeLater {
                        when (event) {
                            "step"      -> log("→ ${data?.optString("message", "") ?: ""}".trimEnd())
                            "completed" -> {
                                log("✔ Completed")
                                runButton.isEnabled = true
                                val ans = Messages.showYesNoDialog(
                                    project,
                                    "Task completed. View git diff?",
                                    "MCP Done",
                                    Messages.getQuestionIcon()
                                )
                                if (ans == Messages.YES) showDiff(client, jobId)
                            }
                            "failed"    -> {
                                log("✘ Failed: ${data?.optString("error", "unknown error") ?: "unknown error"}")
                                runButton.isEnabled = true
                            }
                            else        -> data?.let { log(it.toString()) }
                        }
                    }
                }
            } catch (e: Exception) {
                SwingUtilities.invokeLater {
                    log("✘ Error: ${e.message}")
                    runButton.isEnabled = true
                }
            }
        }.start()
    }

    private fun showDiff(client: McpClient, jobId: String) {
        Thread {
            try {
                val diff = client.getDiff(jobId).optString("diff", "(no diff)")
                SwingUtilities.invokeLater {
                    val area = JTextArea(diff).apply {
                        font      = Font(Font.MONOSPACED, Font.PLAIN, 12)
                        isEditable = false
                    }
                    val scroll = JScrollPane(area).apply { preferredSize = Dimension(700, 450) }
                    val ans = Messages.showOkCancelDialog(
                        project, "", "Git Diff — Job $jobId",
                        "Revert (safe)", "Close", Messages.getWarningIcon()
                    )
                    if (ans == Messages.OK) {
                        Thread {
                            try {
                                client.revert(jobId, hard = false)
                                SwingUtilities.invokeLater { log("↩ Reverted safely (git revert commit).") }
                            } catch (e: Exception) {
                                SwingUtilities.invokeLater { log("✘ Revert error: ${e.message}") }
                            }
                        }.start()
                    }
                }
            } catch (e: Exception) {
                SwingUtilities.invokeLater { log("✘ Diff error: ${e.message}") }
            }
        }.start()
    }

    /** Prepend selected text + file path from the active editor. */
    private fun enrichPrompt(raw: String): String {
        val editor   = FileEditorManager.getInstance(project).selectedTextEditor ?: return raw
        val document = editor.document
        val selection = editor.selectionModel
        val filePath  = FileEditorManager.getInstance(project)
            .selectedFiles.firstOrNull()?.path ?: return raw
        val parts = mutableListOf("[File: $filePath]")
        if (selection.hasSelection()) {
            val lang = filePath.substringAfterLast('.', "")
            parts += "[Selected $lang]:\n```$lang\n${selection.selectedText?.take(2000)}\n```"
        }
        return "${parts.joinToString("\n")}\n\n$raw"
    }
}
