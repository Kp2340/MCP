package `in`.decorom.mcp

import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.Font
import java.io.File
import java.nio.file.Files
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream
import javax.swing.*

class McpToolWindow(private val project: Project) {

    val panel: JPanel = JPanel(BorderLayout(8, 8))

    private val promptField = JTextField()
    private val serverLabel = JLabel()
    private val runButton   = JButton("\u25b6  Run")
    private val syncButton  = JButton("\u2601 Sync & Run")
    private val clearButton = JButton("Clear")
    private val logArea     = JTextArea().apply {
        isEditable    = false
        font          = Font("Monospaced", Font.PLAIN, 12)
        lineWrap      = true
        wrapStyleWord = true
    }

    init {
        val scrollPane = JScrollPane(logArea)

        val btnRow = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.X_AXIS)
            add(runButton)
            add(Box.createHorizontalStrut(4))
            add(syncButton)
            add(Box.createHorizontalStrut(4))
            add(clearButton)
        }

        val form = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            add(serverLabel)
            add(Box.createVerticalStrut(4))
            add(JLabel("Prompt:"))
            add(promptField.apply {
                preferredSize = Dimension(320, 28)
                maximumSize   = Dimension(Int.MAX_VALUE, 28)
            })
            add(Box.createVerticalStrut(6))
            add(btnRow)
        }

        panel.add(form, BorderLayout.NORTH)
        panel.add(scrollPane, BorderLayout.CENTER)

        val s = McpSettings.instance
        serverLabel.text = "<html><small>Server: <b>${s.baseUrl}</b></small></html>"

        Thread {
            val ok = runCatching { McpClient(s.baseUrl, s.apiKey).health() }.getOrDefault(false)
            SwingUtilities.invokeLater {
                log(if (ok) "\u2713 Server reachable"
                    else "\u26a0 Cannot reach server \u2014 check Settings \u2192 Tools \u2192 AI Dev MCP")
            }
        }.start()

        promptField.addActionListener { onRun() }
        runButton.addActionListener   { onRun() }
        syncButton.addActionListener  { onSync() }
        clearButton.addActionListener { logArea.text = "" }
    }

    // -------------------------------------------------------------------------

    private fun log(msg: String) {
        val t = java.time.LocalTime.now().toString().take(8)
        SwingUtilities.invokeLater {
            logArea.append("[$t] $msg\n")
            logArea.caretPosition = logArea.document.length
        }
    }

    private fun validated(): McpClient? {
        val s = McpSettings.instance
        if (s.baseUrl.isEmpty() || s.apiKey.isEmpty()) {
            Messages.showErrorDialog(
                project,
                "Configure baseUrl and apiKey in Settings \u2192 Tools \u2192 AI Dev MCP",
                "MCP Not Configured"
            )
            return null
        }
        return McpClient(s.baseUrl, s.apiKey)
    }

    private fun workspacePath(): String? =
        project.basePath ?: McpSettings.instance.defaultProject.ifEmpty { null }

    private fun projectName(): String {
        val override = McpSettings.instance.defaultProject
        if (override.isNotEmpty()) return override.lowercase().replace(Regex("[^a-z0-9_-]"), "-")
        return (workspacePath()?.let { File(it).name } ?: "unknown")
            .lowercase().replace(Regex("[^a-z0-9_-]"), "-")
    }

    private fun buildPromptWithContext(prompt: String): String {
        val editor   = FileEditorManager.getInstance(project).selectedTextEditor ?: return prompt
        val selected = editor.selectionModel.selectedText?.trim()
        val filePath = editor.virtualFile?.path ?: return prompt
        return if (!selected.isNullOrEmpty())
            prompt + "\n\n// Context from $filePath:\n" + selected
        else
            "$prompt  // file: $filePath"
    }

    // ── Run (server already has the project) ----------------------------------
    private fun onRun() {
        val prompt = promptField.text.trim()
        val wpPath = workspacePath() ?: run {
            Messages.showWarningDialog(project, "Open a project first.", "MCP")
            return
        }
        if (prompt.isEmpty()) {
            Messages.showWarningDialog(project, "Enter a prompt.", "MCP")
            return
        }
        val client = validated() ?: return
        val full   = buildPromptWithContext(prompt)

        logArea.text = ""
        setButtons(false)
        log("\u25b6 Running: \"${full.take(80)}\"")
        log("  Path: $wpPath")

        Thread {
            try {
                val jobId = client.runTask(full, wpPath)
                log("  Job ID: $jobId")
                client.stream(jobId) { event, data ->
                    when (event) {
                        "step" -> log("  \u2022 ${data?.optString("message") ?: data}")
                        "completed" -> {
                            log("\u2714 Done")
                            setButtons(true)
                            SwingUtilities.invokeLater {
                                if (Messages.showYesNoDialog(
                                        project, "Task complete. View diff?", "MCP", null
                                    ) == Messages.YES
                                ) {
                                    runCatching { log(client.getDiff(jobId).toString(2)) }
                                }
                            }
                        }
                        "failed" -> {
                            log("\u2718 Failed: ${data?.optString("error") ?: data}")
                            setButtons(true)
                        }
                    }
                }
            } catch (e: Exception) {
                log("Error: ${e.message}")
                setButtons(true)
            }
        }.start()
    }

    // ── Sync & Run (zip local → push → run → pull → unzip) -------------------
    private fun onSync() {
        val localDir = workspacePath()?.let { File(it) } ?: run {
            Messages.showWarningDialog(project, "Open a project folder first.", "MCP")
            return
        }
        val prompt = Messages.showInputDialog(
            project,
            "Prompt for AI agent (leave empty to only sync files):",
            "MCP Workspace Sync",
            null
        ) ?: return
        val client  = validated() ?: return
        val projKey = projectName()

        setButtons(false)
        logArea.text = ""
        log("\u2601 Syncing workspace \u2018$projKey\u2019 to server...")

        Thread {
            try {
                // 1. Zip
                val tmpZip = Files.createTempFile("mcp-$projKey-", ".zip").toFile()
                log("  Zipping ${localDir.absolutePath}...")
                zipDir(localDir, tmpZip)
                log("  Zip size: ${tmpZip.length() / 1024} KB")

                // 2. Push
                log("  Uploading to server...")
                val pushResult = client.pushWorkspace(projKey, tmpZip.readBytes())
                log("  Push OK: ${pushResult.optInt("fileCount")} files on server")
                tmpZip.delete()

                if (prompt.isBlank()) {
                    log("\u2714 Sync complete (no prompt \u2014 files ready on server)")
                    setButtons(true)
                    return@Thread
                }

                // 3. Submit job
                log("  Submitting job...")
                val jobId = client.runTask(prompt, projKey)
                log("  Job ID: $jobId")

                // 4. Stream progress
                client.stream(jobId) { event, data ->
                    when (event) {
                        "step"      -> log("  \u2022 ${data?.optString("message") ?: data}")
                        "completed" -> log("  \u2714 Agent finished")
                        "failed"    -> throw RuntimeException(
                            data?.optString("error") ?: "unknown error"
                        )
                    }
                }

                // 5. Pull changes back
                log("  Pulling changes from server...")
                val zipBytes = client.pullWorkspace(projKey)
                val pullZip  = Files.createTempFile("mcp-pull-", ".zip").toFile()
                pullZip.writeBytes(zipBytes)
                unzipTo(pullZip, localDir)
                pullZip.delete()

                log("\u2714 Changes applied to ${localDir.absolutePath}")
                setButtons(true)
                SwingUtilities.invokeLater {
                    Messages.showInfoMessage(
                        "AI agent finished. Changes applied to your workspace.", "MCP"
                    )
                }
            } catch (e: Exception) {
                log("\u2718 Sync error: ${e.message}")
                setButtons(true)
            }
        }.start()
    }

    private fun setButtons(enabled: Boolean) {
        SwingUtilities.invokeLater {
            runButton.isEnabled  = enabled
            syncButton.isEnabled = enabled
        }
    }

    // ── Pure-Kotlin zip / unzip (no external tools needed) -------------------

    private fun zipDir(src: File, dest: File) {
        ZipOutputStream(dest.outputStream().buffered()).use { zos ->
            src.walkTopDown()
                .filter { it.isFile && !shouldSkip(it, src) }
                .forEach { file ->
                    val entryName = file.relativeTo(src).path.replace('\\', '/')
                    zos.putNextEntry(ZipEntry(entryName))
                    file.inputStream().use { it.copyTo(zos) }
                    zos.closeEntry()
                }
        }
    }

    private fun unzipTo(zip: File, destDir: File) {
        ZipInputStream(zip.inputStream().buffered()).use { zis ->
            var entry = zis.nextEntry
            while (entry != null) {
                val out = File(destDir, entry.name)
                if (entry.isDirectory) {
                    out.mkdirs()
                } else {
                    out.parentFile?.mkdirs()
                    out.outputStream().use { zis.copyTo(it) }
                }
                zis.closeEntry()
                entry = zis.nextEntry
            }
        }
    }

    private fun shouldSkip(file: File, root: File): Boolean {
        val skipDirs = setOf(
            "node_modules", ".git", "build", "dist",
            ".gradle", ".idea", "__pycache__", ".venv"
        )
        return file.relativeTo(root).path
            .split(File.separator)
            .any { it in skipDirs }
    }
}
