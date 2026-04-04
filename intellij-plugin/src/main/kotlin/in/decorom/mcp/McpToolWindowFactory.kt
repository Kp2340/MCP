package `in`.decorom.mcp

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory

/**
 * Registers the AI Dev MCP sidebar panel.
 * Called by IntelliJ when the tool window is first opened.
 *
 * Registers the created McpToolWindow in McpToolWindowRegistry so that
 * inline editor actions (Fix, Explain, Refactor) can dispatch prompts into it.
 */
class McpToolWindowFactory : ToolWindowFactory {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val window  = McpToolWindow(project)
        McpToolWindowRegistry.register(project, window)

        // Unregister when the project closes to avoid leaking stale references
        project.messageBus.connect().subscribe(
            com.intellij.openapi.project.ProjectManagerListener.TOPIC,
            object : com.intellij.openapi.project.ProjectManagerListener {
                override fun projectClosing(closedProject: Project) {
                    if (closedProject === project) McpToolWindowRegistry.unregister(project)
                }
            }
        )

        val content = ContentFactory.getInstance()
            .createContent(window.panel, "", false)
        toolWindow.contentManager.addContent(content)
    }
}
