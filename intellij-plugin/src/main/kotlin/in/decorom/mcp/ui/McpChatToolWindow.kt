package in.decorom.mcp.ui

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.components.JBTextField
import java.awt.BorderLayout
import javax.swing.JButton
import javax.swing.JPanel
import javax.swing.SwingUtilities
import kotlinx.coroutines.GlobalScope
import kotlinx.coroutines.launch
import in.decorom.mcp.client.McpClient

class McpChatToolWindowFactory : ToolWindowFactory {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val panel = JPanel(BorderLayout())

        val input = JBTextField()
        val output = JBTextArea()
        output.isEditable = false

        val button = JButton("Send")

        val client = McpClient()

        button.addActionListener {
            val prompt = input.text
            output.text = ""

            GlobalScope.launch {
                client.streamCode(prompt, "mcp") { chunk ->
                    SwingUtilities.invokeLater {
                        output.append(chunk)
                    }
                }
            }
        }

        panel.add(input, BorderLayout.NORTH)
        panel.add(JBScrollPane(output), BorderLayout.CENTER)
        panel.add(button, BorderLayout.SOUTH)

        val content = toolWindow.contentManager.factory.createContent(panel, "MCP Chat", false)
        toolWindow.contentManager.addContent(content)
    }
}
