package `in`.decorom.mcp

import com.intellij.openapi.options.Configurable
import javax.swing.*
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import java.awt.Insets

class McpSettingsComponent : Configurable {

    private val baseUrlField   = JTextField(40)
    private val apiKeyField    = JPasswordField(40)
    private val projectField   = JTextField(40)

    override fun getDisplayName() = "AI Dev MCP"

    override fun createComponent(): JComponent {
        val panel = JPanel(GridBagLayout())
        val gc    = GridBagConstraints().apply {
            fill    = GridBagConstraints.HORIZONTAL
            insets  = Insets(4, 4, 4, 4)
            weightx = 0.0
            gridx   = 0
        }

        fun row(label: String, field: JComponent) {
            gc.gridx = 0; gc.weightx = 0.0
            panel.add(JLabel(label), gc)
            gc.gridx = 1; gc.weightx = 1.0
            panel.add(field, gc)
            gc.gridy = (gc.gridy ?: 0) + 1
        }

        row("Server URL:",      baseUrlField)
        row("API Key:",         apiKeyField)
        row("Default Project:", projectField)

        val hint = JLabel("<html><small>Leave Default Project empty to auto-detect from open project name.</small></html>")
        gc.gridx = 1; gc.weightx = 1.0
        panel.add(hint, gc)

        reset()
        return panel
    }

    override fun isModified(): Boolean {
        val s = McpSettings.instance
        return baseUrlField.text.trim()                    != s.baseUrl ||
               String(apiKeyField.password).trim()         != s.apiKey  ||
               projectField.text.trim()                    != s.defaultProject
    }

    override fun apply() {
        val s = McpSettings.instance
        s.baseUrl        = baseUrlField.text.trim()
        s.apiKey         = String(apiKeyField.password).trim()
        s.defaultProject = projectField.text.trim()
    }

    override fun reset() {
        val s = McpSettings.instance
        baseUrlField.text = s.baseUrl
        apiKeyField.text  = s.apiKey
        projectField.text = s.defaultProject
    }
}
