package `in`.decorom.mcp

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.wm.ToolWindowManager

class RunPromptAction : AnAction() {

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val settings = McpSettings.instance

        if (settings.apiKey.isBlank()) {
            Messages.showErrorDialog(
                project,
                "API key is not set.\n\nGo to Settings → Tools → AI Dev MCP and enter your key for ${McpSettings.DEFAULT_BASE_URL}.",
                "MCP: API Key Required"
            )
            return
        }

        // Open the tool window so the user can interact via the panel
        val tw = ToolWindowManager.getInstance(project).getToolWindow("AI Dev MCP")
        tw?.show()
    }
}
