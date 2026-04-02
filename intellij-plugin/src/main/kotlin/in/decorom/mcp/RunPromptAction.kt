package `in`.decorom.mcp

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.wm.ToolWindowManager

/**
 * Keyboard-shortcut action: Ctrl+Shift+M
 * Opens the AI Dev MCP tool window and focuses the prompt field.
 */
class RunPromptAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        ToolWindowManager.getInstance(project)
            .getToolWindow("AI Dev MCP")
            ?.activate(null)
    }
}
