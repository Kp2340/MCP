package `in`.decorom.mcp

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys

class McpWriteTestsAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        InlineActions.run(e, "WriteTests") { code, file, proj ->
            "project: $proj\nFile: $file\nWrite unit tests for the following code:\n```\n$code\n```"
        }
    }
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null && e.getData(CommonDataKeys.EDITOR)?.selectionModel?.hasSelection() == true
    }
}
