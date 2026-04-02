package `in`.decorom.mcp

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.wm.ToolWindowManager

/** Ctrl+Shift+M — opens the MCP tool window and focuses the prompt field. */
class RunPromptAction : AnAction() {

    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val tw = ToolWindowManager.getInstance(project).getToolWindow("AI Dev MCP") ?: return
        tw.show()
        tw.activate(null)
    }
}
