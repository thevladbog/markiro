package app.markiro.handheld.feature.pairing

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material.icons.outlined.Warning
import androidx.compose.material.icons.outlined.WifiOff
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.sp
import app.markiro.handheld.R
import app.markiro.handheld.core.design.FullScreenState
import app.markiro.handheld.core.design.MarkiroSizes
import app.markiro.handheld.core.design.MarkiroTextButton
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.design.PrimaryButton
import app.markiro.handheld.core.design.ScreenColumn
import app.markiro.handheld.core.design.SecondaryButton
import app.markiro.handheld.core.design.StateAction
import app.markiro.handheld.core.design.Tone
import app.markiro.handheld.core.design.tone

data class HostPairingCallbacks(
    val onAddress: (String) -> Unit = {},
    val onCode: (String) -> Unit = {},
    val onContinue: () -> Unit = {},
    val onMatch: () -> Unit = {},
    val onNoMatch: () -> Unit = {},
    val onRetry: () -> Unit = {},
    val onRetrySync: () -> Unit = {},
    val onDone: () -> Unit = {},
)

/** The first choice of a not yet paired device: the cloud or an on-site host. A device is one or the other for life. */
@Composable
fun PairingSourceScreen(onCloud: () -> Unit, onHost: () -> Unit) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Column(Modifier.fillMaxSize().background(c.surfacePage)) {
        ScreenColumn(padding = PaddingValues(MarkiroSizes.sp4), verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3)) {
            Text(stringResource(R.string.pairing_brand), style = t.label, color = c.fg3)
            Text(stringResource(R.string.host_pairing_source_title), style = t.title, color = c.fg1)
            Spacer(Modifier.height(MarkiroSizes.sp3))
            PrimaryButton(stringResource(R.string.host_pairing_source_cloud), onCloud)
            SecondaryButton(stringResource(R.string.host_pairing_source_host), onHost)
        }
    }
}

@Composable
fun HostPairingScreen(state: HostPairingUi, callbacks: HostPairingCallbacks) {
    val c = MarkiroTheme.colors
    Column(Modifier.fillMaxSize().background(c.surfacePage)) {
        when (state) {
            is HostPairingUi.Enter -> EnterAddressAndCode(state, callbacks)
            is HostPairingUi.Verify -> Verify(state, callbacks)
            HostPairingUi.Binding -> FullScreenState(
                Icons.Outlined.Sync,
                stringResource(R.string.pairing_binding_title),
                stringResource(R.string.host_pairing_binding),
                tone = Tone.Info,
            )
            is HostPairingUi.Failed -> FullScreenState(
                iconOf(state.error),
                stringResource(R.string.host_pairing_error_title),
                stringResource(messageOf(state.error)),
                primary = StateAction(
                    stringResource(if (state.canRetrySync) R.string.host_pairing_retry_sync else R.string.common_retry),
                    if (state.canRetrySync) callbacks.onRetrySync else callbacks.onRetry,
                ),
                tone = if (state.canRetrySync) Tone.Warn else Tone.Err,
            )
            HostPairingUi.Success -> FullScreenState(
                Icons.Outlined.CheckCircle,
                stringResource(R.string.host_pairing_success),
                "",
                primary = StateAction(stringResource(R.string.pairing_go_sign_in), callbacks.onDone),
                tone = Tone.Ok,
            )
        }
    }
}

@Composable
private fun EnterAddressAndCode(state: HostPairingUi.Enter, callbacks: HostPairingCallbacks) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    ScreenColumn(padding = PaddingValues(MarkiroSizes.sp4), verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3)) {
        Text(stringResource(R.string.pairing_brand), style = t.label, color = c.fg3)
        Text(stringResource(if (state.repairing) R.string.host_pairing_repair_title else R.string.host_pairing_title), style = t.title, color = c.fg1)
        Text(stringResource(R.string.host_pairing_hint), style = t.body.copy(fontSize = 15.sp), color = c.fg2)
        OutlinedTextField(
            value = state.address,
            onValueChange = callbacks.onAddress,
            label = { Text(stringResource(R.string.host_pairing_address)) },
            singleLine = true,
            // The address of a paired device is its own: shown, not edited.
            readOnly = state.repairing,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = state.code,
            onValueChange = callbacks.onCode,
            label = { Text(stringResource(R.string.host_pairing_code)) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, keyboardType = KeyboardType.Ascii),
            modifier = Modifier.fillMaxWidth(),
        )
        state.error?.let { Text(stringResource(messageOf(it)), style = t.body, color = c.tone(Tone.Err).fg) }
        PrimaryButton(stringResource(R.string.host_pairing_continue), callbacks.onContinue)
    }
}

@Composable
private fun Verify(state: HostPairingUi.Verify, callbacks: HostPairingCallbacks) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    ScreenColumn(padding = PaddingValues(MarkiroSizes.sp4), verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3)) {
        Text(stringResource(R.string.host_pairing_verify_title), style = t.title, color = c.fg1)
        Text(state.address, style = t.label, color = c.fg3)
        // Four characters per group, two groups a line: easy to read against the office's screen.
        state.display.split(' ').chunked(2).forEach { line ->
            Text(line.joinToString(" "), style = t.key, color = c.fg1, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
        }
        Text(stringResource(R.string.host_pairing_verify_hint), style = t.body.copy(fontSize = 15.sp), color = c.fg2)
        if (state.changed) {
            Text(stringResource(R.string.host_pairing_verify_changed), style = t.body, color = c.tone(Tone.Warn).fg)
        }
        PrimaryButton(stringResource(R.string.host_pairing_match), callbacks.onMatch)
        MarkiroTextButton(stringResource(R.string.host_pairing_no_match), callbacks.onNoMatch, tone = Tone.Err)
    }
}

private fun iconOf(error: HostPairingError) = when (error) {
    HostPairingError.UNREACHABLE, HostPairingError.TIMEOUT -> Icons.Outlined.WifiOff
    HostPairingError.PAIRING_INVALID, HostPairingError.PAIRING_EXPIRED, HostPairingError.RATE_LIMITED -> Icons.Outlined.Key
    else -> Icons.Outlined.Warning
}

private fun messageOf(error: HostPairingError): Int = when (error) {
    HostPairingError.ADDRESS_INVALID -> R.string.host_pairing_error_address_invalid
    HostPairingError.CODE_INVALID -> R.string.host_pairing_error_code_invalid
    HostPairingError.UNREACHABLE -> R.string.host_pairing_error_unreachable
    HostPairingError.TIMEOUT -> R.string.host_pairing_error_timeout
    HostPairingError.NOT_A_HOST -> R.string.host_pairing_error_not_a_host
    HostPairingError.HOST_TOO_OLD -> R.string.host_pairing_error_host_too_old
    HostPairingError.APP_TOO_OLD -> R.string.host_pairing_error_app_too_old
    HostPairingError.NO_ADDRESS_MATCHES -> R.string.host_pairing_error_no_address_matches
    HostPairingError.PAIRING_INVALID -> R.string.host_pairing_error_pairing_invalid
    HostPairingError.PAIRING_EXPIRED -> R.string.host_pairing_error_pairing_expired
    HostPairingError.RATE_LIMITED -> R.string.host_pairing_error_rate_limited
    HostPairingError.SEAT_LIMIT -> R.string.host_pairing_error_seat_limit
    HostPairingError.FEATURE_DISABLED -> R.string.host_pairing_error_feature_disabled
    HostPairingError.CERTIFICATE_MISMATCH -> R.string.host_pairing_error_certificate_mismatch
    HostPairingError.OTHER -> R.string.host_pairing_error_other
    HostPairingError.SYNC_FAILED -> R.string.host_pairing_error_sync_failed
}
