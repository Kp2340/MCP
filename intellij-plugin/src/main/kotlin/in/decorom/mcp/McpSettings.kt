package `in`.decorom.mcp

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage

@State(name = "McpSettings", storages = [Storage("McpSettings.xml")])
class McpSettings : PersistentStateComponent<McpSettings.State> {

    data class State(
        var baseUrl:        String = "",
        var apiKey:         String = "",
        var defaultProject: String = ""
    )

    private var _state = State()

    override fun getState()          = _state
    override fun loadState(s: State) { _state = s }

    var baseUrl:        String get() = _state.baseUrl;        set(v) { _state.baseUrl        = v }
    var apiKey:         String get() = _state.apiKey;         set(v) { _state.apiKey         = v }
    var defaultProject: String get() = _state.defaultProject; set(v) { _state.defaultProject = v }

    companion object {
        val instance: McpSettings
            get() = ApplicationManager.getApplication().getService(McpSettings::class.java)
    }
}
