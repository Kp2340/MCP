package `in`.decorom.mcp

import com.intellij.openapi.project.Project

/**
 * Process-level registry mapping each open IntelliJ Project to its
 * McpToolWindow instance.
 *
 * Why: IntelliJ doesn't offer a clean way to retrieve a custom ToolWindow
 * instance from outside the factory. We register on creation and unregister
 * on project close so that editor actions can dispatch prompts directly into
 * the correct window without re-building the component tree.
 */
object McpToolWindowRegistry {
    private val map = java.util.concurrent.ConcurrentHashMap<Project, McpToolWindow>()

    fun register(project: Project, window: McpToolWindow) {
        map[project] = window
    }

    fun unregister(project: Project) {
        map.remove(project)
    }

    fun get(project: Project): McpToolWindow? = map[project]
}
