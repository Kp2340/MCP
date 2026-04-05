package `in`.decorom.mcp

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys

class McpRefactorAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        InlineActions.run(e, "Refactor") { code, file, proj ->
            "project: $proj\nFile: $file\nRefactor the following code for clarity and performance:\n```\n$code\n```"
        }
    }
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null && e.getData(CommonDataKeys.EDITOR)?.selectionModel?.hasSelection() == true
    }
}
