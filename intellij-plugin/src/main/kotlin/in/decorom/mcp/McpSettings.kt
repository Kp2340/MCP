package `in`.decorom.mcp

import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.service

@State(
    name = "McpSettings",
    storages = [Storage("McpSettings.xml")]
)
@Service(Service.Level.APP)
class McpSettings : PersistentStateComponent<McpSettings.State> {

    data class State(
        var baseUrl:        String = "https://ai.decorom.in",
        var apiKey:         String = "",
        var defaultProject: String = ""
    )

    private var myState = State()

    override fun getState(): State = myState

    override fun loadState(state: State) {
        myState = state
    }

    var baseUrl: String
        get() = myState.baseUrl
        set(v) { myState.baseUrl = v }

    var apiKey: String
        get() = myState.apiKey
        set(v) { myState.apiKey = v }

    var defaultProject: String
        get() = myState.defaultProject
        set(v) { myState.defaultProject = v }

    companion object {
        val instance: McpSettings get() = service()
    }
}
