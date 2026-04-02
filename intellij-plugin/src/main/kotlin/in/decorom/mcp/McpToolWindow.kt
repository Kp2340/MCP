package `in`.decorom.mcp

import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import org.json.JSONObject
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Dimension
import java.awt.Font
import javax.swing.*
import javax.swing.text.SimpleAttributeSet
import javax.swing.text.StyleConstants

/**
 * Sidebar panel UI.
 *
 * Layout (top to bottom):
 *   [server URL label]
 *   [prompt field]  [Run button]  [Cancel button]
 *   [Workspace Sync button]
 *   [log pane — colour-coded SSE output]
 *   [diff viewer — shown after job completes]
 *   [Accept / Revert buttons — shown after job completes]
 */
class McpToolWindow(private val project: Project) {

    val panel: JPanel = JPanel(BorderLayout(6, 6)).apply { border = BorderFactory.createEmptyBorder(8, 8, 8, 8) }

    // ── form fields ───────────────────────────────────────────────────────────
    private val serverLabel   = JLabel()
    private val promptField   = JTextField().apply { toolTipText = "Describe what you want the agent to do" }
    private val runButton     = JButton("Run")
    private val cancelButton  = JButton("Cancel").apply { isEnabled = false }
    private val syncButton    = JButton("Workspace Sync")

    // ── log pane (colour-coded) ───────────────────────────────────────────────
    private val logPane   = JTextPane().apply {
        isEditable = false; font = Font("Monospaced", Font.PLAIN, 12)
    }
    private val logScroll = JScrollPane(logPane)

    // ── diff viewer (hidden until a job completes) ────────────────────────────
    private val diffArea   = JTextArea().apply {
        isEditable = false; font = Font("Monospaced", Font.PLAIN, 11)
        lineWrap = false; tabSize = 4
    }
    private val diffScroll = JScrollPane(diffArea).apply {
        preferredSize = Dimension(0, 200)
        isVisible = false
    }
    private val diffLabel  = JLabel("Changed files:").apply { isVisible = false }

    // ── accept / revert controls (hidden until a job completes) ───────────────
    private val acceptButton = JButton("Accept changes").apply { isVisible = false }
    private val revertButton = JButton("Revert").apply { isVisible = false }
    private val diffPanel    = JPanel(BorderLayout(4, 4)).apply { isVisible = false }

    // ── live state ────────────────────────────────────────────────────────────
    @Volatile private var activeJobId: String? = null
    @Volatile private var streamThread: Thread? = null

    init {
        buildUi()
        refreshServerLabel()
        checkServerHealth()

        promptField.addActionListener { onRun() }   // Enter key
        runButton.addActionListener   { onRun() }
        cancelButton.addActionListener { onCancel() }
        syncButton.addActionListener  { onWorkspaceSync() }
        acceptButton.addActionListener { hideDiffPanel() }
        revertButton.addActionListener { onRevert() }
    }

    // ── UI construction ───────────────────────────────────────────────────────
    private fun buildUi() {
        val topBar = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            add(serverLabel.apply { font = Font(font.name, Font.PLAIN, 11) })
            add(Box.createVerticalStrut(4))

            val promptRow = JPanel(BorderLayout(4, 0))
            promptRow.add(promptField, BorderLayout.CENTER)
            val btnRow = JPanel().apply {
                layout = BoxLayout(this, BoxLayout.X_AXIS)
                add(runButton);    add(Box.createHorizontalStrut(4))
                add(cancelButton); add(Box.createHorizontalStrut(4))
                add(syncButton)
            }
            add(promptRow)
            add(Box.createVerticalStrut(4))
            add(btnRow)
        }

        // diff panel: label + scrollable text area + accept/revert buttons
        val reviewRow = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.X_AXIS)
            add(acceptButton); add(Box.createHorizontalStrut(8)); add(revertButton)
        }
        diffPanel.add(diffLabel,  BorderLayout.NORTH)
        diffPanel.add(diffScroll, BorderLayout.CENTER)
        diffPanel.add(reviewRow,  BorderLayout.SOUTH)

        val centerSplit = JPanel(BorderLayout(0, 4))
        centerSplit.add(logScroll,  BorderLayout.CENTER)
        centerSplit.add(diffPanel,  BorderLayout.SOUTH)

        panel.add(topBar,       BorderLayout.NORTH)
        panel.add(centerSplit,  BorderLayout.CENTER)
    }

    // ── actions ───────────────────────────────────────────────────────────────
    private fun onRun() {
        val prompt    = promptField.text.trim()
        val settings  = McpSettings.instance
        val projName  = project.name

        if (settings.baseUrl.isEmpty() || settings.apiKey.isEmpty()) {
            Messages.showErrorDialog(project,
                "Go to Settings → Tools → AI Dev MCP and enter your server URL and API key.",
                "MCP not configured")
            return
        }
        if (prompt.isEmpty()) {
            Messages.showWarningDialog(project, "Enter a prompt first.", "MCP")
            return
        }

        val fullPrompt = buildPromptWithContext(prompt)
        hideDiffPanel()
        clearLog()
        setRunning(true)
        log("Running: ${fullPrompt.take(100)}", "info")

        streamThread = Thread({
            try {
                val client = McpClient(settings.baseUrl, settings.apiKey)
                val jobId  = client.runTask(fullPrompt, projName)
                activeJobId = jobId
                SwingUtilities.invokeLater { log("Job: $jobId", "muted") }

                client.stream(jobId) { event, data ->
                    SwingUtilities.invokeLater { handleStreamEvent(event, data, client, jobId) }
                }
            } catch (e: InterruptedException) {
                SwingUtilities.invokeLater { log("Cancelled.", "warn") }
            } catch (e: Exception) {
                SwingUtilities.invokeLater {
                    log("Error: ${e.message}", "error")
                    setRunning(false)
                }
            }
        }, "mcp-stream")
        streamThread!!.isDaemon = true
        streamThread!!.start()
    }

    private fun onCancel() {
        streamThread?.interrupt()
        setRunning(false)
        log("Cancelled by user.", "warn")
    }

    private fun onRevert() {
        val jobId = activeJobId ?: return
        val hard  = Messages.showYesNoDialog(
            project,
            "Hard reset removes all uncommitted changes and cannot be undone.\n" +
            "Use safe revert (creates an undo-commit) instead?",
            "Revert strategy",
            "Safe revert", "Hard reset", null
        ) == Messages.NO  // NO = Hard reset

        Thread({
            try {
                val result = McpClient(McpSettings.instance.baseUrl, McpSettings.instance.apiKey)
                    .revert(jobId, hard)
                SwingUtilities.invokeLater {
                    log("Reverted: ${result.optString("message", "done")}", "ok")
                    hideDiffPanel()
                }
            } catch (e: Exception) {
                SwingUtilities.invokeLater { log("Revert failed: ${e.message}", "error") }
            }
        }, "mcp-revert").also { it.isDaemon = true }.start()
    }

    private fun onWorkspaceSync() {
        Messages.showInfoMessage(
            project,
            "Workspace Sync pushes your project to the server, runs the agent, then pulls changes back.\n\n" +
            "Use the VSCode extension for full Workspace Sync — the IntelliJ plugin works with\n" +
            "pre-registered projects (the server admin adds your project to projects.json).",
            "Workspace Sync"
        )
    }

    // ── SSE event handler ─────────────────────────────────────────────────────
    private fun handleStreamEvent(event: String, data: JSONObject?, client: McpClient, jobId: String) {
        when (event) {
            "step"         -> log(data?.optString("detail", "") ?: "", "info")
            "budget_warning" -> log(
                data?.optString("detail", "") ?: "LLM budget reached — agent finishing with analysis only.",
                "warn"
            )
            "completed"    -> {
                log("Done.", "ok")
                setRunning(false)
                showDiffViewer(client, jobId)
            }
            "failed"       -> {
                log("Failed: ${data?.optString("error", "unknown error")}", "error")
                setRunning(false)
            }
            else           -> data?.let { log(it.optString("detail", event), "muted") }
        }
    }

    // ── diff viewer ───────────────────────────────────────────────────────────
    /**
     * Fetches GET /diff/:id and populates the diff pane with:
     *  - a summary header (commit hash, message, N files)
     *  - the full unified diff with +/- colour coding
     * Then reveals the Accept / Revert buttons.
     */
    private fun showDiffViewer(client: McpClient, jobId: String) {
        Thread({
            try {
                val diff = client.getDiff(jobId)
                SwingUtilities.invokeLater {
                    val commitMsg  = diff.optString("commitMsg",  "")
                    val commitHash = diff.optString("commitHash", "").take(8)
                    val files      = diff.optJSONArray("files")
                    val rawDiff    = diff.optString("diff", "")

                    val fileCount  = files?.length() ?: 0
                    diffLabel.text = "$fileCount file(s) changed   [$commitHash] $commitMsg"

                    renderColorDiff(rawDiff)

                    diffPanel.isVisible  = true
                    diffScroll.isVisible = true
                    diffLabel.isVisible  = true
                    acceptButton.isVisible = true
                    revertButton.isVisible = true
                    panel.revalidate()
                    panel.repaint()
                }
            } catch (e: Exception) {
                SwingUtilities.invokeLater { log("Could not load diff: ${e.message}", "warn") }
            }
        }, "mcp-diff").also { it.isDaemon = true }.start()
    }

    /**
     * Renders a unified diff string into the diff JTextPane with colour coding:
     *   +  lines  →  green
     *   -  lines  →  red
     *   @@ lines  →  blue / bold
     *   rest      →  default text
     */
    private fun renderColorDiff(rawDiff: String) {
        val doc = diffArea
        doc.text = ""
        if (rawDiff.isBlank()) { doc.text = "(no diff — no commits yet or nothing changed)"; return }

        val sb = StringBuilder()
        for (line in rawDiff.lines()) {
            sb.appendLine(line)
        }
        doc.text = sb.toString()

        // Colour-code via line scanning with a StyledDocument
        // For JTextArea we keep it simple: just set the full text.
        // Switch to JTextPane + StyledDocument for richer rendering:
        val styled = JTextPane()
        styled.isEditable = false
        styled.font = Font("Monospaced", Font.PLAIN, 11)
        val sdoc = styled.styledDocument

        val normal = SimpleAttributeSet()
        val added  = SimpleAttributeSet().also { StyleConstants.setForeground(it, Color(0, 150, 80)) }
        val removed = SimpleAttributeSet().also { StyleConstants.setForeground(it, Color(190, 40, 40)) }
        val hunk   = SimpleAttributeSet().also {
            StyleConstants.setForeground(it, Color(30, 100, 200))
            StyleConstants.setBold(it, true)
        }

        for (line in rawDiff.lines()) {
            val attr = when {
                line.startsWith("+") && !line.startsWith("++") -> added
                line.startsWith("-") && !line.startsWith("--") -> removed
                line.startsWith("@@")                          -> hunk
                else                                           -> normal
            }
            sdoc.insertString(sdoc.length, line + "\n", attr)
        }

        // Replace the plain JTextArea content with the styled pane inside the scroll
        SwingUtilities.invokeLater {
            diffScroll.viewport.view = styled
        }
    }

    private fun hideDiffPanel() {
        diffPanel.isVisible    = false
        acceptButton.isVisible = false
        revertButton.isVisible = false
        panel.revalidate(); panel.repaint()
    }

    // ── context injection ─────────────────────────────────────────────────────
    /**
     * Appends current file name and selected text (if any) to the prompt.
     * This gives the agent immediate, zero-effort context about what the
     * developer is looking at.
     */
    private fun buildPromptWithContext(prompt: String): String {
        val editor       = FileEditorManager.getInstance(project).selectedTextEditor ?: return prompt
        val virtualFile  = FileEditorManager.getInstance(project).selectedFiles.firstOrNull()
        val filePath     = virtualFile?.path ?: ""
        val selectedText = editor.selectionModel.selectedText?.trim() ?: ""

        return buildString {
            append(prompt)
            if (filePath.isNotEmpty()) {
                append("\n\nCurrent file: $filePath")
            }
            if (selectedText.isNotEmpty() && selectedText.length <= 4000) {
                append("\n\nSelected code:\n```\n$selectedText\n```")
            }
        }
    }

    // ── log helpers ───────────────────────────────────────────────────────────
    private fun clearLog() { SwingUtilities.invokeLater { logPane.text = "" } }

    private fun log(message: String, level: String = "info") {
        if (!SwingUtilities.isEventDispatchThread()) {
            SwingUtilities.invokeLater { log(message, level) }; return
        }
        if (message.isBlank()) return
        val doc  = logPane.styledDocument
        val attr = SimpleAttributeSet()
        when (level) {
            "ok"    -> StyleConstants.setForeground(attr, Color(0, 150, 80))
            "warn"  -> StyleConstants.setForeground(attr, Color(180, 100, 0))
            "error" -> StyleConstants.setForeground(attr, Color(190, 40, 40))
            "muted" -> StyleConstants.setForeground(attr, Color(120, 120, 120))
            else    -> StyleConstants.setForeground(attr, UIManager.getColor("TextPane.foreground") ?: Color.BLACK)
        }
        doc.insertString(doc.length, message + "\n", attr)
        logPane.caretPosition = doc.length
    }

    // ── state helpers ─────────────────────────────────────────────────────────
    private fun setRunning(running: Boolean) {
        runButton.isEnabled    = !running
        cancelButton.isEnabled = running
        syncButton.isEnabled   = !running
    }

    private fun refreshServerLabel() {
        serverLabel.text = "Server: ${McpSettings.instance.baseUrl}"
    }

    private fun checkServerHealth() {
        Thread({
            val ok = try { McpClient(McpSettings.instance.baseUrl, McpSettings.instance.apiKey).health() }
                     catch (_: Exception) { false }
            SwingUtilities.invokeLater {
                log(if (ok) "Server connected." else "Cannot reach server — check Settings.",
                    if (ok) "ok" else "warn")
            }
        }, "mcp-health").also { it.isDaemon = true }.start()
    }
}
