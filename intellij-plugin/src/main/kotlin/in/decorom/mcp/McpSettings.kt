package `in`.decorom.mcp

import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.service

@State(
    name = "McpSettings",
    storages = [Storage("McpSettings.xml")]
)
class McpSettings : PersistentStateComponent<McpSettings.State> {

    data class State(
        var baseUrl: String        = "https://ai.decorom.in",
        var apiKey: String         = "",
        var defaultProject: String = ""
    )

    private var myState = State()

    override fun getState(): State = myState
    override fun loadState(state: State) { myState = state }

    var baseUrl: String
        get() = myState.baseUrl.ifBlank { "https://ai.decorom.in" }
        set(v) { myState.baseUrl = v.trimEnd('/') }

    var apiKey: String
        get() = myState.apiKey
        set(v) { myState.apiKey = v.trim() }

    var defaultProject: String
        get() = myState.defaultProject
        set(v) { myState.defaultProject = v.trim() }

    companion object {
        val instance: McpSettings get() = service()
    }
}
