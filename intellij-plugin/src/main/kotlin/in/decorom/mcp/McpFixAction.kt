package `in`.decorom.mcp

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys

class McpFixAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        InlineActions.run(e, "Fix") { code, file, proj ->
            "project: $proj\nFile: $file\nFix the following code:\n```\n$code\n```"
        }
    }
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null && e.getData(CommonDataKeys.EDITOR)?.selectionModel?.hasSelection() == true
    }
}
