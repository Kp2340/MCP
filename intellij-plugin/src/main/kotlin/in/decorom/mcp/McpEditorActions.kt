package `in`.decorom.mcp

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys

/**
 * Abstract base class for inline editor actions (Fix, Explain, Refactor, WriteTests).
 *
 * Concrete implementations live in their own files:
 *   McpFixAction.kt, McpExplainAction.kt, McpRefactorAction.kt, McpWriteTestsAction.kt
 *
 * Each subclass just overrides buildPrompt() — this base handles:
 *   - Editor context extraction (selected text, file path, language)
 *   - Dispatching via InlineActions.run() on a background thread
 */
abstract class McpEditorAction : AnAction() {

    // Must run on EDT for Swing / editor model access
    override fun getActionUpdateThread() = ActionUpdateThread.EDT

    /**
     * Build the prompt to send to the MCP agent.
     * @param selectedText  the highlighted code (may be empty)
     * @param filePath      absolute path of the active file
     * @param language      file type name lowercased (e.g. "kotlin", "java")
     */
    abstract fun buildPrompt(selectedText: String, filePath: String, language: String): String

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor  = e.getData(CommonDataKeys.EDITOR) ?: return

        val selectedText = editor.selectionModel.selectedText.orEmpty()
        val filePath     = editor.virtualFile?.path ?: ""
        val language     = editor.virtualFile?.fileType?.name?.lowercase() ?: ""
        val projName     = project.name.lowercase().replace(Regex("[^a-z0-9_-]"), "-")

        val prompt = buildPrompt(selectedText, filePath, language)

        InlineActions.run(e, actionLabel()) { _, _, _ -> prompt }
    }

    /** Label shown in the progress dialog (e.g. "Fix", "Explain"). Override to customize. */
    open fun actionLabel(): String = "Run"

    /** Visible only when an editor is focused. */
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.getData(CommonDataKeys.EDITOR) != null
    }
}
