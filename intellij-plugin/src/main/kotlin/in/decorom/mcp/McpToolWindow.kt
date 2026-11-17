package `in`.decorom.mcp

import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import org.json.JSONObject
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Font
import javax.swing.*
import javax.swing.text.SimpleAttributeSet
import javax.swing.text.StyleConstants

class McpToolWindow(private val project: Project) {

    val panel: JPanel = JPanel(BorderLayout(8, 8))

    private val promptField = JTextField()
    private val runButton   = JButton("\u25B6  Run")
    private val clearButton = JButton("Clear")
    private val syncButton  = JButton("\u2601 Sync & Run")
    private val pullButton  = JButton("\u2B07 Pull Changes")
    private val logPane     = JTextPane().apply {
        isEditable = false
        font = Font("Monospaced", Font.PLAIN, 12)
    }
    private val scrollPane = JScrollPane(logPane)

    private fun projName(): String {
        val s = McpSettings.instance
        if (s.defaultProject.isNotBlank()) return s.defaultProject.trim().lowercase().replace(Regex("[^a-z0-9_-]"), "-")
        return project.name.lowercase().replace(Regex("[^a-z0-9_-]"), "-")
    }

    init {
        val settings = McpSettings.instance

        // ── Button bar ──────────────────────────────────────────────────────────
        val btnBar = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.X_AXIS)
            add(runButton)
            add(Box.createHorizontalStrut(6))
            add(syncButton)
            add(Box.createHorizontalStrut(6))
            add(pullButton)
            add(Box.createHorizontalStrut(6))
            add(clearButton)
        }

        // ── Top form ────────────────────────────────────────────────────────────
        val urlLabel = JLabel("<html><small>Server: ${settings.baseUrl}</small></html>")
        val form = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            add(urlLabel)
            add(Box.createVerticalStrut(4))
            add(JLabel("Prompt:"))
            add(promptField)
            add(Box.createVerticalStrut(6))
            add(btnBar)
        }

        panel.add(form, BorderLayout.NORTH)
        panel.add(scrollPane, BorderLayout.CENTER)

        // Health check on open
        Thread {
            val ok = try { McpClient(settings.baseUrl, settings.apiKey).health() } catch (_: Exception) { false }
            SwingUtilities.invokeLater { log(if (ok) "\u2713 Server connected: ${settings.baseUrl}" else "\u26A0 Cannot reach server \u2014 check Settings \u2192 Tools \u2192 AI Dev MCP", Color.GRAY) }
        }.start()

        promptField.addActionListener { onRun() }
        runButton.addActionListener   { onRun() }
        clearButton.addActionListener { logPane.text = "" }
        syncButton.addActionListener  { onSync() }
        pullButton.addActionListener  { onPull() }
    }

    // ── Prompt injection ────────────────────────────────────────────────────────
    private fun buildPromptWithContext(base: String): String {
        val editor   = FileEditorManager.getInstance(project).selectedTextEditor ?: return "project: ${projName()}\n$base"
        val selected = editor.selectionModel.selectedText?.trim() ?: ""
        val filePath = FileEditorManager.getInstance(project).selectedFiles.firstOrNull()?.path ?: ""
        return buildString {
            append("project: ${projName()}\n")
            if (filePath.isNotEmpty()) append("File: $filePath\n")
            if (selected.isNotEmpty()) append("Selected code:\n```\n$selected\n```\n")
            append(base)
        }
    }

    // ── Run ─────────────────────────────────────────────────────────────────────
    private fun onRun() {
        val prompt   = promptField.text.trim()
        val settings = McpSettings.instance
        if (!validateSettings(settings)) return
        if (prompt.isEmpty()) { Messages.showWarningDialog(project, "Enter a prompt.", "MCP"); return }

        val fullPrompt = buildPromptWithContext(prompt)
        logPane.text   = ""
        setRunning(true)
        log("\u25B6 Submitting: \"${fullPrompt.take(80)}...\"")

        Thread {
            try {
                val client = McpClient(settings.baseUrl, settings.apiKey)
                val jobId  = client.runTask(fullPrompt, projName())
                SwingUtilities.invokeLater { log("  Job: $jobId") }

                client.stream(jobId) { event, data ->
                    SwingUtilities.invokeLater {
                        when (event) {
                            "step"      -> log("  \u2192 ${data?.optString("detail", "") ?: ""}", Color(0x4CAF50))
                            "completed" -> {
                                log("\u2714 Done!", Color(0x4CAF50))
                                setRunning(false)
                                val ans = Messages.showYesNoDialog(project, "Task complete. Review changes?", "AI Dev MCP", "Show diff", "Dismiss", null)
                                if (ans == Messages.YES) showDiff(client, jobId)
                            }
                            "failed"    -> {
                                log("\u2716 Failed: ${data?.optString("error", "unknown")}", Color(0xF44336))
                                setRunning(false)
                            }
                        }
                    }
                }
            } catch (e: Exception) {
                SwingUtilities.invokeLater { log("Error: ${e.message}", Color(0xF44336)); setRunning(false) }
            }
        }.start()
    }

    // ── Workspace Sync ──────────────────────────────────────────────────────────
    private fun onSync() {
        val settings = McpSettings.instance
        if (!validateSettings(settings)) return
        val basePath = project.basePath ?: run { Messages.showErrorDialog(project, "No project folder open.", "MCP"); return }
        val prompt   = promptField.text.trim()
        if (prompt.isEmpty()) { Messages.showWarningDialog(project, "Enter a prompt first.", "MCP"); return }

        setRunning(true)
        log("\u2601 Zipping workspace...")

        Thread {
            try {
                val zipBytes = ZipHelper.zipFolder(basePath)
                val client   = McpClient(settings.baseUrl, settings.apiKey)
                SwingUtilities.invokeLater { log("  Uploading ${zipBytes.size / 1024}KB...") }

                val pushResult = client.pushWorkspace(projName(), zipBytes)
                val jobId      = client.runTask(buildPromptWithContext(prompt), projName())
                SwingUtilities.invokeLater { log("  Job: $jobId") }

                client.stream(jobId) { event, data ->
                    SwingUtilities.invokeLater {
                        when (event) {
                            "step"      -> log("  \u2192 ${data?.optString("detail", "")}", Color(0x4CAF50))
                            "completed" -> {
                                log("\u2714 Done! Pull changes to apply them locally.", Color(0x4CAF50))
                                setRunning(false)
                            }
                            "failed" -> {
                                log("\u2716 Failed: ${data?.optString("error")}", Color(0xF44336))
                                setRunning(false)
                            }
                        }
                    }
                }
            } catch (e: Exception) {
                SwingUtilities.invokeLater { log("Sync error: ${e.message}", Color(0xF44336)); setRunning(false) }
            }
        }.start()
    }

    // ── Pull changes ────────────────────────────────────────────────────────────
    private fun onPull() {
        val settings = McpSettings.instance
        if (!validateSettings(settings)) return
        val basePath = project.basePath ?: return

        setRunning(true)
        log("\u2B07 Pulling changes...")

        Thread {
            try {
                val client   = McpClient(settings.baseUrl, settings.apiKey)
                val zipBytes = client.pullWorkspace(projName())
                ZipHelper.unzipTo(zipBytes, basePath)
                SwingUtilities.invokeLater {
                    log("\u2714 Changes pulled to $basePath", Color(0x4CAF50))
                    setRunning(false)
                }
            } catch (e: Exception) {
                SwingUtilities.invokeLater { log("Pull error: ${e.message}", Color(0xF44336)); setRunning(false) }
            }
        }.start()
    }

    // ── Diff viewer ─────────────────────────────────────────────────────────────
    private fun showDiff(client: McpClient, jobId: String) {
        Thread {
            try {
                val diff  = client.getDiff(jobId)
                val files = diff.optJSONArray("files")
                SwingUtilities.invokeLater {
                    val doc = logPane.styledDocument
                    log("\n\u2015\u2015 Diff: ${diff.optString("commitMsg", "")} \u2015\u2015")
                    if (files != null) {
                        for (i in 0 until files.length()) {
                            val f      = files.getJSONObject(i)
                            val status = f.optString("status", "M")
                            val color  = when (status) { "A" -> Color(0x4CAF50); "D" -> Color(0xF44336); else -> Color(0x64B5F6) }
                            val attr   = SimpleAttributeSet().also { StyleConstants.setForeground(it, color) }
                            doc.insertString(doc.length, "  [$status] ${f.optString("path")}\n", attr)
                        }
                    }
                }
            } catch (e: Exception) {
                SwingUtilities.invokeLater { log("Diff error: ${e.message}", Color(0xF44336)) }
            }
        }.start()
    }

    // ── Helpers ─────────────────────────────────────────────────────────────────
    private fun validateSettings(s: McpSettings): Boolean {
        if (s.baseUrl.isBlank() || s.apiKey.isBlank()) {
            Messages.showErrorDialog(project, "Configure Server URL and API Key in Settings \u2192 Tools \u2192 AI Dev MCP", "MCP Not Configured")
            return false
        }
        return true
    }

    private fun setRunning(running: Boolean) {
        runButton.isEnabled  = !running
        syncButton.isEnabled = !running
        pullButton.isEnabled = !running
    }

    private fun log(msg: String, color: Color? = null) {
        val doc  = logPane.styledDocument
        val attr = SimpleAttributeSet()
        if (color != null) StyleConstants.setForeground(attr, color)
        doc.insertString(doc.length, "$msg\n", attr)
        logPane.caretPosition = doc.length
    }
}
