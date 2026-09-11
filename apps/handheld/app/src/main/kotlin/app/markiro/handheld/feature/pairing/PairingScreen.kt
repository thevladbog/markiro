package app.markiro.handheld.feature.pairing

import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material.icons.outlined.WifiOff
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.markiro.handheld.R
import app.markiro.handheld.core.design.FullScreenState
import app.markiro.handheld.core.design.Keypad
import app.markiro.handheld.core.design.MarkiroSizes
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.design.StateAction
import app.markiro.handheld.core.design.Tone
import app.markiro.handheld.core.network.PairingError

data class PairingCallbacks(
    val onDigit: (Char) -> Unit = {},
    val onBackspace: () -> Unit = {},
    val onConfirm: () -> Unit = {},
    val onServerUrl: (String) -> Unit = {},
    val onRetry: () -> Unit = {},
    val onDone: () -> Unit = {},
)

@Composable
fun PairingScreen(state: PairingUi, callbacks: PairingCallbacks) {
    val c = MarkiroTheme.colors
    Column(Modifier.fillMaxSize().background(c.surfacePage)) {
        when (state) {
            is PairingUi.Recovery -> FullScreenState(
                Icons.Outlined.Lock,
                stringResource(if (state.unresolved) R.string.recovery_unresolved_title else R.string.recovery_title),
                buildString {
                    append(stringResource(if (state.unresolved) R.string.recovery_unresolved_text else R.string.recovery_text))
                    state.deviceId?.let { append("\n"); append(it) }
                    append("\n\n")
                    append(state.summary?.let {
                        stringResource(R.string.recovery_summary, it["scans"] ?: 0, it["inventory"] ?: 0, it["labels"] ?: 0,
                            it["boxes"] ?: 0, it["exceptions"] ?: 0, it["closes"] ?: 0, it["conflicts"] ?: 0, it["unknownPrints"] ?: 0)
                    } ?: stringResource(R.string.recovery_summary_unknown))
                },
                primary = if (state.unresolved) null else StateAction(stringResource(R.string.recovery_connect), callbacks.onRetry),
                tone = Tone.Warn,
                scrollable = true,
            )
            is PairingUi.Enter -> EnterCode(state, callbacks)
            PairingUi.Binding -> FullScreenState(
                Icons.Outlined.Sync,
                stringResource(R.string.pairing_binding_title),
                stringResource(R.string.pairing_binding_text),
                tone = Tone.Info,
            )
            is PairingUi.Failed -> Failed(state.error, callbacks.onRetry)
            is PairingUi.Success -> FullScreenState(
                Icons.Outlined.CheckCircle,
                stringResource(if (state.restored) R.string.recovery_success_title else R.string.pairing_success_title),
                listOfNotNull(state.organizationName, state.lineName, if (state.restored) stringResource(R.string.recovery_success_text) else null).joinToString(" · "),
                primary = StateAction(stringResource(R.string.pairing_go_sign_in), callbacks.onDone),
                tone = Tone.Ok,
            )
        }
    }
}

@Composable
private fun EnterCode(state: PairingUi.Enter, callbacks: PairingCallbacks) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(MarkiroSizes.sp4), verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3)) {
        Text(stringResource(R.string.pairing_brand), style = t.label, color = c.fg3)
        Text(stringResource(if (state.restoring) R.string.recovery_connect else R.string.pairing_title), style = t.title, color = c.fg1)
        Text(stringResource(if (state.restoring) R.string.recovery_code_hint else R.string.pairing_hint), style = t.body.copy(fontSize = 15.sp), color = c.fg2)
        Row(Modifier.fillMaxWidth().height(56.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
            val typed = state.code.toList().joinToString(" ")
            val rest = List(8 - state.code.length) { "_" }.joinToString(" ")
            Text(typed, style = t.key, color = c.fg1)
            if (rest.isNotEmpty()) Text((if (typed.isEmpty()) "" else " ") + rest, style = t.key, color = c.fgDisabled)
        }
        Keypad(callbacks.onDigit, callbacks.onBackspace, callbacks.onConfirm, confirmEnabled = state.code.length == 8)
        if (state.serverEditable) {
            OutlinedTextField(
                value = state.serverUrl,
                onValueChange = callbacks.onServerUrl,
                label = { Text(stringResource(R.string.pairing_server_url)) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        Spacer(Modifier.height(MarkiroSizes.sp3))
    }
}

@Composable
private fun Failed(error: PairingError, onRetry: () -> Unit) {
    when (error) {
        PairingError.RECOVERY_MISMATCH, PairingError.UPDATE_REQUIRED, PairingError.OWNER_UNRESOLVED, PairingError.PUBLICATION_FAILED -> FullScreenState(
            Icons.Outlined.Lock,
            stringResource(R.string.recovery_title),
            stringResource(when (error) {
                PairingError.RECOVERY_MISMATCH -> R.string.recovery_mismatch
                PairingError.UPDATE_REQUIRED -> R.string.recovery_update_required
                PairingError.OWNER_UNRESOLVED -> R.string.recovery_unresolved_text
                else -> R.string.recovery_publication_failed
            }),
            primary = if (error == PairingError.OWNER_UNRESOLVED) null else StateAction(stringResource(R.string.common_retry), onRetry),
            tone = Tone.Err,
        )
        PairingError.INVALID, PairingError.EXPIRED, PairingError.INVALID_RESPONSE -> FullScreenState(
            Icons.Outlined.Key,
            stringResource(R.string.pairing_invalid_title),
            stringResource(R.string.pairing_invalid_text),
            primary = StateAction(stringResource(R.string.pairing_invalid_action), onRetry),
            tone = Tone.Err,
        )
        PairingError.LOCKED, PairingError.RATE_LIMITED -> FullScreenState(
            Icons.Outlined.Lock,
            stringResource(R.string.pairing_locked_title),
            stringResource(R.string.pairing_locked_text),
            primary = StateAction(stringResource(R.string.common_got_it), onRetry),
            tone = Tone.Warn,
            primaryIsAccent = false,
        )
        PairingError.UNAVAILABLE -> FullScreenState(
            Icons.Outlined.WifiOff,
            stringResource(R.string.common_server_unavailable),
            stringResource(R.string.pairing_unavailable_text),
            primary = StateAction(stringResource(R.string.common_retry), onRetry),
            tone = Tone.Err,
        )
        PairingError.KIND_MISMATCH -> FullScreenState(
            Icons.Outlined.Key,
            stringResource(R.string.pairing_kind_title),
            stringResource(R.string.pairing_kind_text),
            primary = StateAction(stringResource(R.string.pairing_other_code), onRetry),
            tone = Tone.Warn,
        )
    }
}
