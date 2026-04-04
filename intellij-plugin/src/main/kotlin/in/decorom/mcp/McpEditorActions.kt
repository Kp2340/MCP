package `in`.decorom.mcp

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.wm.ToolWindowManager

/**
 * Inline editor actions for AI Dev MCP.
 *
 * Registered in plugin.xml under <actions><group id="McpEditorGroup">.
 * They appear in:
 *   - Right-click context menu inside any editor (Editor Popup Menu)
 *   - Main menu  Tools → AI Dev MCP → ...
 *   - Keyboard shortcuts (see plugin.xml)
 *
 * Each action:
 *  1. Grabs selected text + current file path from the editor
 *  2. Builds a pre-filled prompt
 *  3. Pastes it into the MCP tool window prompt field and fires Run
 *
 * No project name is used — project.name is resolved automatically inside
 * McpToolWindow.onRun().
 */

// ─────────────────────────────────────────────────────────────────────────
// Shared base — handles selection guard + tool window dispatch
// ─────────────────────────────────────────────────────────────────────────

abstract class McpEditorAction : AnAction() {

    // Must run on EDT for Swing access
    override fun getActionUpdateThread() = ActionUpdateThread.EDT

    /**
     * Build the prompt that will be pre-filled into the tool window.
     * @param selectedText  the highlighted code (may be blank if nothing selected)
     * @param filePath      absolute path of the open file
     * @param language      file language ID (e.g. "kotlin", "java", "typescript")
     */
    abstract fun buildPrompt(selectedText: String, filePath: String, language: String): String

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor  = e.getData(CommonDataKeys.EDITOR) ?: return

        val selectedText = editor.selectionModel.selectedText.orEmpty()
        val filePath     = editor.virtualFile?.path ?: ""
        val language     = editor.virtualFile?.fileType?.name?.lowercase() ?: ""

        val prompt = buildPrompt(selectedText, filePath, language)

        // Open the MCP tool window, then inject + fire the prompt
        val tw = ToolWindowManager.getInstance(project).getToolWindow("AI Dev MCP") ?: return
        tw.activate {
            // Find the McpToolWindow instance via ContentManager
            val content = tw.contentManager.selectedContent ?: return@activate
            val window  = content.component
            // Walk the component tree to find the McpToolWindow panel
            // The panel is the root JPanel registered in McpToolWindowFactory
            McpToolWindowRegistry.get(project)?.submitPrompt(prompt)
        }
    }

    /** Visible only when an editor is focused. */
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.getData(CommonDataKeys.EDITOR) != null
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Concrete actions
// ─────────────────────────────────────────────────────────────────────────

/** Right-click → "Fix with MCP" — send selected code for bug-fixing */
class McpFixAction : McpEditorAction() {
    override fun buildPrompt(selectedText: String, filePath: String, language: String): String {
        val codeBlock = if (selectedText.isNotBlank())
            "\n\n```$language\n${selectedText.take(4_000)}\n```"
        else ""
        return "Fix any bugs or errors in this $language code from `$filePath`:$codeBlock"
    }
}

/** Right-click → "Explain with MCP" — ask the agent to explain the selection */
class McpExplainAction : McpEditorAction() {
    override fun buildPrompt(selectedText: String, filePath: String, language: String): String {
        val codeBlock = if (selectedText.isNotBlank())
            "\n\n```$language\n${selectedText.take(4_000)}\n```"
        else ""
        return "Explain what this $language code does, step by step. File: `$filePath`:$codeBlock"
    }
}

/** Right-click → "Refactor with MCP" — improve structure/readability */
class McpRefactorAction : McpEditorAction() {
    override fun buildPrompt(selectedText: String, filePath: String, language: String): String {
        val codeBlock = if (selectedText.isNotBlank())
            "\n\n```$language\n${selectedText.take(4_000)}\n```"
        else ""
        return "Refactor this $language code to improve readability, structure, and best practices. File: `$filePath`:$codeBlock"
    }
}

/** Right-click → "Write Tests with MCP" — generate unit tests for selection */
class McpWriteTestsAction : McpEditorAction() {
    override fun buildPrompt(selectedText: String, filePath: String, language: String): String {
        val codeBlock = if (selectedText.isNotBlank())
            "\n\n```$language\n${selectedText.take(4_000)}\n```"
        else ""
        return "Write comprehensive unit tests for this $language code from `$filePath`:$codeBlock"
    }
}
