package `in`.decorom.mcp

import com.intellij.openapi.options.Configurable
import javax.swing.*
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import java.awt.Insets

/**
 * Settings page shown under Settings → Tools → AI Dev MCP.
 * Persists baseUrl and apiKey via McpSettings.
 */
class McpSettingsComponent : Configurable {

    private val baseUrlField     = JTextField(40)
    private val apiKeyField      = JPasswordField(40)
    private val defaultProjField = JTextField(40)
    private var mainPanel: JPanel? = null

    override fun getDisplayName() = "AI Dev MCP"

    override fun createComponent(): JComponent {
        val panel = JPanel(GridBagLayout())
        val gbc   = GridBagConstraints().apply {
            anchor = GridBagConstraints.WEST
            insets = Insets(4, 4, 4, 4)
        }

        fun row(label: String, field: JComponent, row: Int) {
            gbc.gridx = 0; gbc.gridy = row; gbc.fill = GridBagConstraints.NONE; gbc.weightx = 0.0
            panel.add(JLabel(label), gbc)
            gbc.gridx = 1; gbc.fill = GridBagConstraints.HORIZONTAL; gbc.weightx = 1.0
            panel.add(field, gbc)
        }

        row("Server URL:",      baseUrlField,     0)
        row("API Key:",         apiKeyField,      1)
        row("Default project:", defaultProjField, 2)

        // help hint
        gbc.gridx = 0; gbc.gridy = 3; gbc.gridwidth = 2; gbc.fill = GridBagConstraints.NONE
        panel.add(JLabel("<html><small>Leave API Key blank if your server has no auth configured.</small></html>"), gbc)

        // filler row to push everything to the top
        gbc.gridy = 4; gbc.weighty = 1.0; gbc.fill = GridBagConstraints.VERTICAL
        panel.add(JPanel(), gbc)

        mainPanel = panel
        reset()       // populate from saved state
        return panel
    }

    override fun isModified(): Boolean {
        val s = McpSettings.instance
        return baseUrlField.text.trim()              != s.baseUrl ||
               String(apiKeyField.password).trim()   != s.apiKey  ||
               defaultProjField.text.trim()          != s.defaultProject
    }

    override fun apply() {
        val s = McpSettings.instance
        s.baseUrl        = baseUrlField.text.trim()
        s.apiKey         = String(apiKeyField.password).trim()
        s.defaultProject = defaultProjField.text.trim()
    }

    override fun reset() {
        val s = McpSettings.instance
        baseUrlField.text     = s.baseUrl
        apiKeyField.text      = s.apiKey
        defaultProjField.text = s.defaultProject
    }

    override fun disposeUIResources() { mainPanel = null }
}
