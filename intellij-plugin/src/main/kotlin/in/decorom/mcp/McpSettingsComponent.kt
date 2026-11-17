package `in`.decorom.mcp

import com.intellij.openapi.options.Configurable
import javax.swing.*
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import java.awt.Insets

class McpSettingsComponent : Configurable {

    private val baseUrlField = JTextField(40)
    private val apiKeyField  = JPasswordField(40)
    private var panel: JPanel? = null

    override fun getDisplayName() = "AI Dev MCP"

    override fun createComponent(): JComponent {
        val p   = JPanel(GridBagLayout())
        val gbc = GridBagConstraints().apply {
            insets   = Insets(4, 4, 4, 4)
            fill     = GridBagConstraints.HORIZONTAL
            weightx  = 1.0
        }

        gbc.gridx = 0; gbc.gridy = 0; gbc.weightx = 0.0
        p.add(JLabel("Server URL:"), gbc)
        gbc.gridx = 1; gbc.weightx = 1.0
        p.add(baseUrlField, gbc)

        gbc.gridx = 0; gbc.gridy = 1; gbc.weightx = 0.0
        p.add(JLabel("API Key:"), gbc)
        gbc.gridx = 1; gbc.weightx = 1.0
        p.add(apiKeyField, gbc)

        gbc.gridx = 0; gbc.gridy = 2; gbc.gridwidth = 2
        p.add(JLabel("<html><small>Leave API Key empty if your server has no auth.</small></html>"), gbc)

        panel = p
        reset()
        return p
    }

    override fun isModified(): Boolean {
        val s = McpSettings.instance
        return baseUrlField.text != s.baseUrl ||
               String(apiKeyField.password) != s.apiKey
    }

    override fun apply() {
        val s = McpSettings.instance
        s.baseUrl = baseUrlField.text.trim().trimEnd('/')
        s.apiKey  = String(apiKeyField.password).trim()
    }

    override fun reset() {
        val s = McpSettings.instance
        baseUrlField.text = s.baseUrl
        apiKeyField.text  = s.apiKey
    }
}
