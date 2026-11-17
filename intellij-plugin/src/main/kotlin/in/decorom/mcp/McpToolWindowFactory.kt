package `in`.decorom.mcp

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory

class McpToolWindowFactory : ToolWindowFactory {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val window  = McpToolWindow(project)
        val content = ContentFactory.getInstance().createContent(window.panel, "", false)
        toolWindow.contentManager.addContent(content)
    }
}
