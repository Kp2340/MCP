package `in`.decorom.mcp

import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.ui.Messages

/**
 * Shared helper for all inline editor actions (Fix, Explain, Refactor, WriteTests).
 * Runs the MCP task on a background thread using IntelliJ's ProgressManager
 * so the UI stays responsive and the user sees a progress dialog.
 */
object InlineActions {

    fun run(
        e: AnActionEvent,
        label: String,
        buildPrompt: (code: String, filePath: String, project: String) -> String
    ) {
        val project  = e.project ?: return
        val editor   = e.getData(CommonDataKeys.EDITOR) ?: return
        val settings = McpSettings.instance

        if (settings.baseUrl.isBlank() || settings.apiKey.isBlank()) {
            Messages.showErrorDialog(project, "Configure Server URL and API Key in Settings \u2192 Tools \u2192 AI Dev MCP", "MCP Not Configured")
            return
        }

        val selected = editor.selectionModel.selectedText?.trim() ?: ""
        val filePath = e.getData(CommonDataKeys.VIRTUAL_FILE)?.path ?: ""
        val projName = project.name.lowercase().replace(Regex("[^a-z0-9_-]"), "-")
        val prompt   = buildPrompt(selected, filePath, projName)

        ProgressManager.getInstance().run(object : Task.Backgroundable(project, "MCP: $label", false) {
            override fun run(indicator: ProgressIndicator) {
                indicator.isIndeterminate = true
                indicator.text = "Submitting to MCP agent..."
                try {
                    val client = McpClient(settings.baseUrl, settings.apiKey)
                    val jobId  = client.runTask(prompt, projName)
                    indicator.text = "Job $jobId running..."

                    client.stream(jobId) { event, data ->
                        when (event) {
                            "step"      -> indicator.text = data?.optString("detail", "Running...") ?: "Running..."
                            "completed" -> indicator.text = "Done!"
                            "failed"    -> throw RuntimeException(data?.optString("error", "MCP job failed") ?: "MCP job failed")
                        }
                    }
                } catch (ex: Exception) {
                    com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater {
                        Messages.showErrorDialog(project, "MCP $label error: ${ex.message}", "MCP Error")
                    }
                }
            }
        })
    }
}
