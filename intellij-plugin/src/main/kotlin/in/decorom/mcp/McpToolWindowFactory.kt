package `in`.decorom.mcp

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory

class McpToolWindowFactory : ToolWindowFactory {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val win     = McpToolWindow(project)
        val content = ContentFactory.getInstance()
            .createContent(win.panel, "", false)
        toolWindow.contentManager.addContent(content)
    }
}
