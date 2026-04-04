package `in`.decorom.mcp

import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import org.json.JSONObject
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Dimension
import java.awt.Font
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream
import javax.swing.*
import javax.swing.text.SimpleAttributeSet
import javax.swing.text.StyleConstants

/**
 * AI Dev MCP sidebar panel — production version.
 *
 * Design principles:
 *  • Zero config UX — project name auto-detected from IntelliJ's project.name
 *  • Auto workspace detection — basePath resolved from IntelliJ context
 *  • MCP-aware — uses project.name as the registered project key
 *  • Real Workspace Sync — zip local folder, upload, run agent, pull changes
 *  • Colour-coded diff rendered in JTextPane (not JTextArea)
 *  • No project name field anywhere in the UI
 *
 * Layout:
 *   ┌─────────────────────────────────────────────┐
 *   │  🔵 ai.decorom.in  │  project: myapp        │
 *   │  [Prompt .................................]  │
 *   │  [▶ Run]  [✕ Cancel]  [⇅ Workspace Sync]   │
 *   ├─────────────────────────────────────────────┤
 *   │  colour-coded log (SSE stream)              │
 *   ├─────────────────────────────────────────────┤
 *   │  diff viewer (hidden until job completes)   │
 *   │  [✔ Accept changes]  [↺ Revert]            │
 *   └─────────────────────────────────────────────┘
 */
class McpToolWindow(private val project: Project) {

    val panel: JPanel = JPanel(BorderLayout(6, 6)).apply {
        border = BorderFactory.createEmptyBorder(8, 8, 8, 8)
    }

    // ── status bar ───────────────────────────────────────────────────────────
    private val statusLabel = JLabel().apply {
        font = Font(font.name, Font.PLAIN, 11)
        toolTipText = "Server connection status"
    }
    private val projectLabel = JLabel().apply {
        font = Font(font.name, Font.BOLD, 11)
        toolTipText = "Auto-detected from open project"
    }

    // ── prompt row ────────────────────────────────────────────────────────────
    private val promptField = JTextField().apply {
        toolTipText = "Describe what you want the agent to do, then press Enter or Run"
    }
    private val runButton    = JButton("▶  Run")
    private val cancelButton = JButton("✕").apply {
        isEnabled  = false
        toolTipText = "Cancel running job"
        preferredSize = Dimension(36, preferredSize.height)
    }
    private val syncButton = JButton("⇅ Sync").apply {
        toolTipText = "Zip workspace → upload → run agent → pull changes back"
    }

    // ── log pane ─────────────────────────────────────────────────────────────
    private val logPane = JTextPane().apply {
        isEditable = false
        font = Font("Monospaced", Font.PLAIN, 12)
    }
    private val logScroll = JScrollPane(logPane).apply {
        border = BorderFactory.createTitledBorder("Agent log")
    }

    // ── diff viewer ───────────────────────────────────────────────────────────
    private val diffPane = JTextPane().apply {
        isEditable = false
        font = Font("Monospaced", Font.PLAIN, 11)
    }
    private val diffScroll = JScrollPane(diffPane).apply {
        preferredSize = Dimension(0, 220)
        isVisible = false
    }
    private val diffLabel    = JLabel().apply  { isVisible = false }
    private val acceptButton = JButton("✔  Accept changes").apply { isVisible = false }
    private val revertButton = JButton("↺  Revert").apply          { isVisible = false }
    private val diffPanel    = JPanel(BorderLayout(4, 4)).apply    { isVisible = false }

    // ── live state ────────────────────────────────────────────────────────────
    @Volatile private var activeJobId: String? = null
    @Volatile private var streamThread: Thread? = null

    // ── colours ───────────────────────────────────────────────────────────────
    private val COL_OK    = Color(0,   160,  80)
    private val COL_ERR   = Color(200,  40,  40)
    private val COL_WARN  = Color(180, 120,   0)
    private val COL_MUTED = Color(130, 130, 130)
    private val COL_INFO  = UIManager.getColor("Label.foreground") ?: Color.BLACK
    private val COL_DIFF_ADD = Color(0, 140, 60)
    private val COL_DIFF_DEL = Color(180, 30, 30)
    private val COL_DIFF_HNK = Color(30,  90, 190)

    init {
        buildUi()
        refreshStatusBar()
        checkServerHealth()

        promptField.addActionListener  { onRun() }     // Enter key
        runButton.addActionListener    { onRun() }
        cancelButton.addActionListener { onCancel() }
        syncButton.addActionListener   { onWorkspaceSync() }
        acceptButton.addActionListener { hideDiffPanel() }
        revertButton.addActionListener { onRevert() }
    }

    // ── UI construction ───────────────────────────────────────────────────────
    private fun buildUi() {
        // status bar: [● server] [project: name]
        val statusBar = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.X_AXIS)
            add(statusLabel)
            add(Box.createHorizontalGlue())
            add(projectLabel)
        }

        // prompt + buttons
        val promptRow = JPanel(BorderLayout(4, 0)).also {
            it.add(promptField, BorderLayout.CENTER)
        }
        val btnRow = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.X_AXIS)
            add(runButton)
            add(Box.createHorizontalStrut(4))
            add(cancelButton)
            add(Box.createHorizontalStrut(4))
            add(syncButton)
        }

        val topBar = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            add(statusBar)
            add(Box.createVerticalStrut(4))
            add(promptRow)
            add(Box.createVerticalStrut(4))
            add(btnRow)
        }

        // diff panel
        val reviewRow = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.X_AXIS)
            add(acceptButton)
            add(Box.createHorizontalStrut(8))
            add(revertButton)
        }
        diffPanel.add(diffLabel,  BorderLayout.NORTH)
        diffPanel.add(diffScroll, BorderLayout.CENTER)
        diffPanel.add(reviewRow,  BorderLayout.SOUTH)

        val center = JPanel(BorderLayout(0, 4))
        center.add(logScroll,  BorderLayout.CENTER)
        center.add(diffPanel,  BorderLayout.SOUTH)

        panel.add(topBar,  BorderLayout.NORTH)
        panel.add(center,  BorderLayout.CENTER)
    }

    // ── status bar ────────────────────────────────────────────────────────────
    private fun refreshStatusBar() {
        val url = McpSettings.instance.baseUrl
            .removePrefix("https://").removePrefix("http://").trimEnd('/')
        statusLabel.text = "⬤ $url"
        projectLabel.text = "project: ${project.name}"
    }

    private fun checkServerHealth() {
        Thread({
            val ok = try { McpClient(McpSettings.instance.baseUrl, McpSettings.instance.apiKey).health() }
                     catch (_: Exception) { false }
            SwingUtilities.invokeLater {
                val url = McpSettings.instance.baseUrl
                    .removePrefix("https://").removePrefix("http://").trimEnd('/')
                if (ok) {
                    statusLabel.text       = "⬤ $url"
                    statusLabel.foreground = COL_OK
                } else {
                    statusLabel.text       = "⬤ $url  (unreachable)"
                    statusLabel.foreground = COL_ERR
                }
            }
        }, "mcp-health").also { it.isDaemon = true }.start()
    }

    // ── public API for editor actions ──────────────────────────────────────────
    /**
     * Called by McpEditorActions to inject a pre-built prompt and fire Run.
     * Safe to call from any thread — dispatches to EDT internally.
     */
    fun submitPrompt(prompt: String) {
        SwingUtilities.invokeLater {
            promptField.text = prompt
            onRun()
        }
    }

    // ── run action ────────────────────────────────────────────────────────────
    private fun onRun() {
        val settings = McpSettings.instance

        // Guard: must be configured
        if (settings.baseUrl.isEmpty() || settings.apiKey.isEmpty()) {
            Messages.showErrorDialog(
                project,
                "Go to Settings → Tools → AI Dev MCP and enter your server URL and API key.",
                "MCP not configured"
            )
            return
        }
        if (prompt.isEmpty()) {
            Messages.showWarningDialog(project, "Enter a prompt first.", "MCP")
            return
        }

        // Auto-detect: use IntelliJ's project.name as the registered project key
        val projectName = project.name

        val fullPrompt = buildPromptWithContext(prompt)
        hideDiffPanel()
        clearLog()
        setRunning(true)
        log("▶ ${fullPrompt.take(120)}", "info")
        log("  project: $projectName", "muted")

        streamThread = Thread({
            try {
                val client = McpClient(settings.baseUrl, settings.apiKey)
                val jobId  = client.runTask(fullPrompt, projectName)
                activeJobId = jobId
                SwingUtilities.invokeLater { log("  job: $jobId", "muted") }

                client.stream(jobId) { event, data ->
                    SwingUtilities.invokeLater { handleStreamEvent(event, data, client, jobId) }
                }
            } catch (e: InterruptedException) {
                SwingUtilities.invokeLater { log("Cancelled.", "warn"); setRunning(false) }
            } catch (e: Exception) {
                SwingUtilities.invokeLater { log("Error: ${e.message}", "error"); setRunning(false) }
            }
        }, "mcp-stream")
        streamThread!!.isDaemon = true
        streamThread!!.start()
    }

    // ── cancel ────────────────────────────────────────────────────────────────
    private fun onCancel() {
        streamThread?.interrupt()
        setRunning(false)
        log("Cancelled.", "warn")
    }

    // ── revert ────────────────────────────────────────────────────────────────
    private fun onRevert() {
        val jobId = activeJobId ?: return
        val useHard = Messages.showYesNoDialog(
            project,
            "Hard reset removes all uncommitted changes and cannot be undone.
" +
            "Use safe revert (creates an undo-commit) instead?",
            "Revert strategy",
            "Safe revert", "Hard reset", null
        ) == Messages.NO

        Thread({
            try {
                val result = McpClient(McpSettings.instance.baseUrl, McpSettings.instance.apiKey)
                    .revert(jobId, useHard)
                SwingUtilities.invokeLater {
                    log("Reverted: ${result.optString("message", "done")}", "ok")
                    hideDiffPanel()
                }
            } catch (e: Exception) {
                SwingUtilities.invokeLater { log("Revert failed: ${e.message}", "error") }
            }
        }, "mcp-revert").also { it.isDaemon = true }.start()
    }

    // ── workspace sync ────────────────────────────────────────────────────────
    /**
     * Real Workspace Sync:
     *  1. Zip the local project root (skipping .git, node_modules, build, dist, .gradle)
     *  2. Upload zip to POST /workspace/upload
     *  3. Run agent job on the server
     *  4. Download result zip from GET /workspace/download/:id
     *  5. Unzip changes back into local project root
     *
     * Runs on a background thread via IntelliJ's ProgressManager so the IDE
     * shows a cancellable progress dialog.
     */
    private fun onWorkspaceSync() {
        val settings    = McpSettings.instance
        val basePath    = project.basePath
        val projectName = project.name

        if (settings.baseUrl.isEmpty() || settings.apiKey.isEmpty()) {
            Messages.showErrorDialog(project,
                "Configure server URL and API key in Settings → Tools → AI Dev MCP.",
                "MCP not configured")
            return
        }
        if (basePath == null) {
            Messages.showErrorDialog(project, "Cannot determine project root path.", "MCP Sync")
            return
        }

        val prompt = promptField.text.trim().ifEmpty {
            Messages.showInputDialog(project,
                "What should the agent do with this workspace?",
                "Workspace Sync", null) ?: return
        }

        object : Task.Backgroundable(project, "AI Dev MCP — Workspace Sync", true) {
            override fun run(indicator: ProgressIndicator) {
                try {
                    val client = McpClient(settings.baseUrl, settings.apiKey)

                    // Step 1: zip
                    indicator.text = "Zipping workspace…"
                    indicator.fraction = 0.1
                    val zipBytes = zipDirectory(File(basePath))
                    SwingUtilities.invokeLater { log("Zipped ${zipBytes.size / 1024} KB", "muted") }

                    // Step 2: upload
                    indicator.text = "Uploading to server…"
                    indicator.fraction = 0.3
                    val uploadId = try {
                        client.uploadWorkspace(zipBytes, projectName)
                    } catch (e: Exception) {
                        // Server may not have workspace routes yet — fall back to job-only mode
                        SwingUtilities.invokeLater {
                            log("Server does not support workspace upload — running job directly.", "warn")
                        }
                        null
                    }

                    // Step 3: run agent
                    indicator.text = "Running agent…"
                    indicator.fraction = 0.5
                    val jobId = client.runTask("[workspace-sync] $prompt", projectName)
                    activeJobId = jobId
                    SwingUtilities.invokeLater { log("Sync job: $jobId", "muted") }

                    // Step 4: stream progress
                    indicator.text = "Agent working…"
                    client.stream(jobId) { event, data ->
                        when (event) {
                            "step"      -> SwingUtilities.invokeLater {
                                log(data?.optString("detail", "") ?: "", "info")
                            }
                            "completed" -> SwingUtilities.invokeLater {
                                log("Agent done.", "ok")
                            }
                            "failed"    -> SwingUtilities.invokeLater {
                                log("Agent failed: ${data?.optString("error", "?")}", "error")
                            }
                        }
                    }

                    // Step 5: download changes (if upload was supported)
                    if (uploadId != null) {
                        indicator.text = "Pulling changes back…"
                        indicator.fraction = 0.85
                        val resultZip = try { client.downloadWorkspace(uploadId) } catch (_: Exception) { null }
                        if (resultZip != null && resultZip.isNotEmpty()) {
                            unzipInto(resultZip, File(basePath))
                            SwingUtilities.invokeLater { log("Changes applied locally.", "ok") }
                        }
                    }

                    indicator.fraction = 1.0
                    SwingUtilities.invokeLater {
                        setRunning(false)
                        showDiffViewer(client, jobId)
                    }

                } catch (e: Exception) {
                    SwingUtilities.invokeLater {
                        log("Sync failed: ${e.message}", "error")
                        setRunning(false)
                    }
                }
            }
        }.queue()
    }

    // ── SSE event handler ─────────────────────────────────────────────────────
    private fun handleStreamEvent(event: String, data: JSONObject?, client: McpClient, jobId: String) {
        when (event) {
            "step"           -> log(data?.optString("detail", "") ?: "", "info")
            "budget_warning" -> log(data?.optString("detail",
                "LLM budget reached — agent finishing with analysis only.") ?: "", "warn")
            "completed"      -> {
                log("✔ Done.", "ok")
                setRunning(false)
                showDiffViewer(client, jobId)
            }
            "failed"         -> {
                log("✘ Failed: ${data?.optString("error", "unknown error")}", "error")
                setRunning(false)
            }
            else             -> data?.let { log(it.optString("detail", event), "muted") }
        }
    }

    // ── diff viewer ───────────────────────────────────────────────────────────
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

                    diffLabel.text    = "$fileCount file(s) changed   [$commitHash] $commitMsg"
                    diffLabel.isVisible  = true
                    diffScroll.isVisible = true
                    diffPanel.isVisible  = true
                    acceptButton.isVisible = true
                    revertButton.isVisible = true

                    renderColorDiff(rawDiff)
                    panel.revalidate(); panel.repaint()
                }
            } catch (e: Exception) {
                SwingUtilities.invokeLater { log("Could not load diff: ${e.message}", "warn") }
            }
        }, "mcp-diff").also { it.isDaemon = true }.start()
    }

    /**
     * Render a unified diff string into diffPane with colour coding using
     * a real StyledDocument — not a plain JTextArea.
     *   + lines  → green
     *   - lines  → red
     *   @@ lines → blue bold
     *   rest     → default fg
     */
    private fun renderColorDiff(rawDiff: String) {
        val sdoc = diffPane.styledDocument
        sdoc.remove(0, sdoc.length)

        if (rawDiff.isBlank()) {
            appendStyled(sdoc, "(no diff — nothing changed or no commits yet)
", COL_MUTED, false)
            return
        }

        for (line in rawDiff.lines()) {
            val (color, bold) = when {
                line.startsWith("+") && !line.startsWith("++") -> Pair(COL_DIFF_ADD, false)
                line.startsWith("-") && !line.startsWith("--") -> Pair(COL_DIFF_DEL, false)
                line.startsWith("@@")                           -> Pair(COL_DIFF_HNK, true)
                else                                            -> Pair(COL_INFO,      false)
            }
            appendStyled(sdoc, line + "
", color, bold)
        }

        // Scroll to top after render
        SwingUtilities.invokeLater { diffPane.caretPosition = 0 }
    }

    private fun appendStyled(
        doc: javax.swing.text.StyledDocument,
        text: String, color: Color, bold: Boolean
    ) {
        val attr = SimpleAttributeSet()
        StyleConstants.setForeground(attr, color)
        StyleConstants.setBold(attr, bold)
        doc.insertString(doc.length, text, attr)
    }

    // ── context injection ─────────────────────────────────────────────────────
    /**
     * Prepend currently selected code + open file path to the prompt.
     * If nothing is selected the prompt is returned unchanged.
     */
    private fun buildPromptWithContext(prompt: String): String {
        val editor = FileEditorManager.getInstance(project).selectedTextEditor ?: return prompt
        val selection = editor.selectionModel.selectedText
        val filePath  = editor.virtualFile?.path

        return buildString {
            if (filePath != null) append("[file: $filePath]
")
            if (!selection.isNullOrBlank()) {
                append("[selected code]
")
                append(selection.take(4_000))   // cap at 4 KB to avoid prompt bloat
                append("
[/selected code]
")
            }
            append(prompt)
        }
    }

    // ── log helpers ───────────────────────────────────────────────────────────
    private fun log(text: String, level: String = "info") {
        if (text.isBlank()) return
        val color = when (level) {
            "ok"    -> COL_OK
            "error" -> COL_ERR
            "warn"  -> COL_WARN
            "muted" -> COL_MUTED
            else    -> COL_INFO
        }
        val sdoc = logPane.styledDocument
        appendStyled(sdoc, text.trimEnd() + "
", color, false)
        // Auto-scroll to bottom
        logPane.caretPosition = sdoc.length
    }

    private fun clearLog() {
        val sdoc = logPane.styledDocument
        sdoc.remove(0, sdoc.length)
    }

    private fun setRunning(running: Boolean) {
        runButton.isEnabled    = !running
        cancelButton.isEnabled = running
        syncButton.isEnabled   = !running
        promptField.isEnabled  = !running
    }

    private fun hideDiffPanel() {
        diffPanel.isVisible    = false
        diffScroll.isVisible   = false
        diffLabel.isVisible    = false
        acceptButton.isVisible = false
        revertButton.isVisible = false
        panel.revalidate(); panel.repaint()
    }

    // ── zip / unzip ───────────────────────────────────────────────────────────
    private val SKIP_DIRS = setOf(
        ".git", "node_modules", "build", "dist", ".gradle",
        ".idea", "out", "target", ".next", ".nuxt", "__pycache__"
    )

    /** Recursively zip a directory, skipping irrelevant folders. */
    private fun zipDirectory(root: File): ByteArray {
        val baos = ByteArrayOutputStream()
        ZipOutputStream(baos).use { zos ->
            fun addEntry(file: File, name: String) {
                if (file.isDirectory) {
                    if (file.name in SKIP_DIRS) return
                    file.listFiles()?.forEach { child ->
                        addEntry(child, "$name/${child.name}")
                    }
                } else {
                    zos.putNextEntry(ZipEntry(name))
                    file.inputStream().use { it.copyTo(zos) }
                    zos.closeEntry()
                }
            }
            root.listFiles()?.forEach { child -> addEntry(child, child.name) }
        }
        return baos.toByteArray()
    }

    /** Unzip bytes into a target directory, overwriting changed files only. */
    private fun unzipInto(zipBytes: ByteArray, targetDir: File) {
        ZipInputStream(zipBytes.inputStream()).use { zis ->
            var entry = zis.nextEntry
            while (entry != null) {
                val dest = File(targetDir, entry.name)
                if (entry.isDirectory) {
                    dest.mkdirs()
                } else {
                    dest.parentFile?.mkdirs()
                    dest.outputStream().use { zis.copyTo(it) }
                }
                zis.closeEntry()
                entry = zis.nextEntry
            }
        }
    }
}
