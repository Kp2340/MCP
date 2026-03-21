package `in`.decorom.mcp

import com.intellij.openapi.options.Configurable
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import java.awt.Insets
import javax.swing.*

class McpSettingsComponent : Configurable {

    private val baseUrlField = JTextField(32)
    private val apiKeyField  = JPasswordField(32)
    private val projectField = JTextField(32)

    override fun getDisplayName() = "AI Dev MCP"

    override fun createComponent(): JPanel {
        val panel = JPanel(GridBagLayout())
        val lc = GridBagConstraints().apply {
            anchor = GridBagConstraints.WEST
            insets = Insets(4, 4, 4, 8)
            gridx  = 0
        }
        val fc = GridBagConstraints().apply {
            fill    = GridBagConstraints.HORIZONTAL
            weightx = 1.0
            insets  = Insets(4, 0, 4, 4)
            gridx   = 1
        }

        fun addRow(label: String, field: JComponent, hint: String, row: Int) {
            lc.gridy = row; panel.add(JLabel(label), lc)
            fc.gridy = row; panel.add(field, fc)
            val hc = GridBagConstraints().apply {
                gridx = 1; gridy = row + 1; fill = GridBagConstraints.HORIZONTAL
                weightx = 1.0; insets = Insets(0, 0, 6, 4)
            }
            panel.add(JLabel("<html><small><i>$hint</i></small></html>"), hc)
        }

        addRow("Server URL:", baseUrlField, "e.g. http://localhost:3001 or your ngrok / Tailscale URL", 0)
        addRow("API Key:",    apiKeyField,  "Matches API_KEY in your server .env file", 2)
        addRow("Default Project:", projectField, "Leave blank — auto-detected from open project folder name", 4)

        panel.add(JPanel(), GridBagConstraints().apply {
            gridy = 6; weighty = 1.0; fill = GridBagConstraints.VERTICAL
        })

        reset()
        return panel
    }

    override fun isModified(): Boolean {
        val s = McpSettings.instance
        return baseUrlField.text.trim()            != s.baseUrl ||
               String(apiKeyField.password).trim() != s.apiKey  ||
               projectField.text.trim()            != s.defaultProject
    }

    override fun apply() {
        McpSettings.instance.apply {
            baseUrl        = baseUrlField.text.trim().trimEnd('/')
            apiKey         = String(apiKeyField.password).trim()
            defaultProject = projectField.text.trim()
        }
    }

    override fun reset() {
        McpSettings.instance.also {
            baseUrlField.text = it.baseUrl
            apiKeyField.text  = it.apiKey
            projectField.text = it.defaultProject
        }
    }
}
