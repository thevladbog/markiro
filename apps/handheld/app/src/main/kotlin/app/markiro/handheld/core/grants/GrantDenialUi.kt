package app.markiro.handheld.core.grants

import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.ui.res.stringResource
import app.markiro.handheld.R
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.flow.MutableStateFlow

/** Typed productive refusal; it never converts unrelated failures into a grant denial. */
class GrantDenialUi {
    private val visible = MutableStateFlow(false)
    val isVisible: kotlinx.coroutines.flow.StateFlow<Boolean> = visible
    fun show() { visible.value=true }
    val handler = CoroutineExceptionHandler { _, error -> if(error is GrantDenied) show() else throw error }
    suspend fun guard(block: suspend () -> Unit) {
        try { block() } catch (_: GrantDenied) { show() }
    }
    @Composable fun Dialog() {
        val show by visible.collectAsState()
        if(show) AlertDialog(onDismissRequest={visible.value=false},
            title={Text(stringResource(R.string.offline_grant_denied_title))},
            text={Text(stringResource(R.string.offline_grant_denied_body))},
            confirmButton={TextButton(onClick={visible.value=false}) { Text(stringResource(android.R.string.ok)) }})
    }
}
