package `in`.decorom.mcp

import com.intellij.openapi.options.Configurable
import java.awt.Dimension
import java.awt.Font
import javax.swing.*

class McpSettingsComponent : Configurable {

    private val baseUrlField    = JTextField()
    private val apiKeyField     = JPasswordField()
    private val projectField    = JTextField()

    override fun getDisplayName() = "AI Dev MCP"

    override fun createComponent(): JComponent {
        val settings = McpSettings.instance
        baseUrlField.text    = settings.baseUrl
        apiKeyField.text     = settings.apiKey
        projectField.text    = settings.defaultProject

        val panel = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            border = BorderFactory.createEmptyBorder(12, 12, 12, 12)
        }

        fun label(text: String) = JLabel(text).also { it.alignmentX = 0f }
        fun hint(text: String)  = JLabel("<html><small>$text</small></html>").also {
            it.foreground = java.awt.Color.GRAY; it.alignmentX = 0f
        }
        fun field(f: JTextField) = f.also {
            it.maximumSize = Dimension(Int.MAX_VALUE, 32); it.alignmentX = 0f
        }

        panel.add(label("Server URL"))
        panel.add(hint("Default: ${McpSettings.DEFAULT_BASE_URL}"))
        panel.add(field(baseUrlField))
        panel.add(Box.createVerticalStrut(10))

        panel.add(label("API Key"))
        panel.add(hint("Required — sent as x-api-key header on every request."))
        panel.add(apiKeyField.also { it.maximumSize = Dimension(Int.MAX_VALUE, 32); it.alignmentX = 0f })
        panel.add(Box.createVerticalStrut(10))

        panel.add(label("Default Project Path (optional)"))
        panel.add(hint("Leave empty to auto-detect from the open project folder."))
        panel.add(field(projectField))

        return panel
    }

    override fun isModified(): Boolean {
        val s = McpSettings.instance
        return baseUrlField.text.trim() != s.baseUrl ||
               String(apiKeyField.password).trim() != s.apiKey ||
               projectField.text.trim() != s.defaultProject
    }

    override fun apply() {
        val s = McpSettings.instance
        val url = baseUrlField.text.trim()
        s.baseUrl        = url.ifEmpty { McpSettings.DEFAULT_BASE_URL }
        s.apiKey         = String(apiKeyField.password).trim()
        s.defaultProject = projectField.text.trim()
    }

    override fun reset() {
        val s = McpSettings.instance
        baseUrlField.text = s.baseUrl
        apiKeyField.text  = s.apiKey
        projectField.text = s.defaultProject
    }

    override fun disposeUIResources() {}
}
