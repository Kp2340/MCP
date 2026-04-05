package `in`.decorom.mcp

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.wm.ToolWindowManager

class RunPromptAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        // Open the tool window so the user can submit prompts from there
        ToolWindowManager.getInstance(project).getToolWindow("AI Dev MCP")?.activate(null)
    }

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null
    }
}
