package `in`.decorom.mcp

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage

/**
 * Persistent application-level settings for AI Dev MCP.
 * Stored in ~/Library/Application Support/JetBrains/.../options/mcp.xml
 * (or equivalent on Windows/Linux).
 */
@State(name = "McpSettings", storages = [Storage("mcp.xml")])
class McpSettings : PersistentStateComponent<McpSettings.State> {

    data class State(
        var baseUrl: String = "https://ai.decorom.in",
        var apiKey: String  = ""
    )

    private var myState = State()

    override fun getState(): State = myState
    override fun loadState(state: State) { myState = state }

    var baseUrl: String
        get() = myState.baseUrl
        set(v) { myState.baseUrl = v.trimEnd('/') }

    var apiKey: String
        get() = myState.apiKey
        set(v) { myState.apiKey = v }

    companion object {
        val instance: McpSettings
            get() = ApplicationManager.getApplication().getService(McpSettings::class.java)
    }
}
