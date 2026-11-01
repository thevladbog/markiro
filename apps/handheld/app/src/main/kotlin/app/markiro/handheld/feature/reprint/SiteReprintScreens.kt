package app.markiro.handheld.feature.reprint

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.selection.selectable
import androidx.compose.ui.semantics.Role
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.markiro.handheld.R
import app.markiro.handheld.core.design.*
import app.markiro.handheld.core.reprint.SiteReprintResult

data class SiteReprintCallbacks(
    val onBack: () -> Unit = {},
    val onSettings: () -> Unit = {},
    val onReason: (String) -> Unit = {},
    val onBegin: () -> Unit = {},
    val onManual: () -> Unit = {},
    val onSubmit: (String) -> Unit = {},
    val onRetry: () -> Unit = {},
    val onVerify: () -> Unit = {},
    val onCancel: () -> Unit = {},
)

@Composable
fun SiteReprintScreen(state: SiteReprintUi, callbacks: SiteReprintCallbacks) {
    var retryUnknown by remember { mutableStateOf(false) }
    var manual by rememberSaveable { mutableStateOf("") }
    LaunchedEffect(state.step, state.busy) { if (state.step != SiteReprintStep.MANUAL || state.busy) manual = "" }
    val c = MarkiroTheme.colors
    Column(Modifier.fillMaxSize().background(c.surfacePage)) {
        AppBar(stringResource(R.string.site_reprint_title), callbacks.onBack, actions = {
            if (state.step == SiteReprintStep.REASON) IconAction(Icons.Outlined.Settings,
                stringResource(R.string.site_reprint_settings), onClick = callbacks.onSettings)
        })
        ScreenColumn(modifier = Modifier.weight(1f), padding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (state.step == SiteReprintStep.LOADING) {
                Icon(Icons.Outlined.Sync, null, tint = c.accent, modifier = Modifier.size(32.dp))
                Text(stringResource(R.string.site_reprint_loading), style = MarkiroTheme.type.title, color = c.fg1)
                return@ScreenColumn
            }
            if (state.step == SiteReprintStep.REASON) {
                Text(stringResource(R.string.site_reprint_reason_title), style = MarkiroTheme.type.title, color = c.fg1)
                Text(stringResource(R.string.site_reprint_reason_body), style = MarkiroTheme.type.body, color = c.fg2)
                SiteReprintViewModel.REASONS.forEach { reason ->
                    val chosen = state.reason == reason
                    val shape = RoundedCornerShape(MarkiroSizes.radius)
                    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).background(c.surfaceCard, shape)
                        .border(1.dp, if (chosen) c.accent else c.surfaceCard, shape)
                        .selectable(selected = chosen, enabled = !state.sealed, role = Role.RadioButton) { callbacks.onReason(reason) }.padding(horizontal = 8.dp),
                        verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(selected = chosen, onClick = null, colors = RadioButtonDefaults.colors(selectedColor = c.accent, unselectedColor = c.fg2))
                        Spacer(Modifier.width(12.dp))
                        Text(stringResource(reasonText(reason)), style = MarkiroTheme.type.body, color = c.fg1,
                            modifier = Modifier.weight(1f).padding(vertical = 12.dp))
                    }
                }
                Spacer(Modifier.weight(1f))
                if (state.catalogUnavailable) Text(stringResource(R.string.site_reprint_catalog_unavailable), style = MarkiroTheme.type.caption, color = c.fg2)
                state.problem?.let { Banner(stringResource(problemText(it)), Tone.Warn, Icons.Outlined.Warning) }
                Text(stringResource(R.string.site_reprint_settings_hint), style = MarkiroTheme.type.caption, color = c.fg2)
                PrimaryButton(stringResource(R.string.site_reprint_begin), callbacks.onBegin, enabled = state.reason != null && !state.sealed)
                return@ScreenColumn
            }
            state.reason?.let { reason ->
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Icon(Icons.Outlined.Assignment, null, tint = c.accent, modifier = Modifier.size(20.dp))
                    Text(stringResource(R.string.site_reprint_reason_selected, stringResource(reasonText(reason))), style = MarkiroTheme.type.caption, color = c.fg2)
                }
            }
            if (state.sealed) {
                Banner(stringResource(problemText(state.problem ?: "pending_other_operator")), Tone.Warn, Icons.Outlined.Lock)
                Text(stringResource(R.string.site_reprint_retained), color = c.fg2, style = MarkiroTheme.type.body)
                return@ScreenColumn
            }
            if (state.step == SiteReprintStep.MANUAL && !state.busy) {
                Text(stringResource(R.string.site_reprint_manual_title), style = MarkiroTheme.type.title, color = c.fg1)
                Text(stringResource(R.string.site_reprint_manual_hint), style = MarkiroTheme.type.body, color = c.fg2)
                OutlinedTextField(value = manual, onValueChange = { manual = it },
                    label = { Text(stringResource(R.string.site_reprint_manual_label)) }, modifier = Modifier.fillMaxWidth(), minLines = 3)
                Spacer(Modifier.weight(1f))
                PrimaryButton(stringResource(R.string.site_reprint_find_print), { val raw = manual; manual = ""; callbacks.onSubmit(raw) }, enabled = manual.isNotBlank())
                return@ScreenColumn
            }
            val unknown = state.result is SiteReprintResult.Unknown
            val failed = state.result as? SiteReprintResult.Failed
            when {
                state.busy -> {
                    Icon(Icons.Outlined.Print, null, tint = c.accent, modifier = Modifier.size(36.dp))
                    Text(stringResource(if (state.step == SiteReprintStep.VERIFY) R.string.site_reprint_verifying else R.string.site_reprint_printing), style = MarkiroTheme.type.title, color = c.fg1)
                    Text(stringResource(R.string.site_reprint_busy_body), style = MarkiroTheme.type.body, color = c.fg2)
                    Text(stringResource(R.string.site_reprint_scans_paused), style = MarkiroTheme.type.caption, color = c.fg2)
                }
                state.step == SiteReprintStep.VERIFY -> {
                    Icon(Icons.Outlined.QrCodeScanner, null, tint = c.accent, modifier = Modifier.size(36.dp))
                    Text(stringResource(R.string.site_reprint_verify_title), style = MarkiroTheme.type.title, color = c.fg1)
                    Text(stringResource(R.string.site_reprint_verify_body), style = MarkiroTheme.type.body, color = c.fg2)
                    state.problem?.let { Banner(stringResource(problemText(it)), Tone.Warn, Icons.Outlined.Warning) }
                }
                unknown -> {
                    Icon(Icons.Outlined.Warning, null, tint = c.tone(Tone.Warn).fg, modifier = Modifier.size(36.dp))
                    Text(stringResource(R.string.site_reprint_unknown), style = MarkiroTheme.type.title, color = c.fg1)
                    Text(stringResource(R.string.site_reprint_unknown_body), style = MarkiroTheme.type.body, color = c.fg2)
                    Spacer(Modifier.weight(1f))
                    PrimaryButton(stringResource(R.string.site_reprint_verify), callbacks.onVerify)
                    SecondaryButton(stringResource(R.string.site_reprint_retry_unknown), { retryUnknown = true })
                }
                failed != null -> {
                    Icon(Icons.Outlined.Warning, null, tint = c.tone(Tone.Warn).fg, modifier = Modifier.size(36.dp))
                    Text(stringResource(R.string.site_reprint_failed), style = MarkiroTheme.type.title, color = c.fg1)
                    Text(stringResource(problemText(failed.code)), style = MarkiroTheme.type.body, color = c.fg2)
                    if (isConfiguration(failed.code)) SecondaryButton(stringResource(R.string.site_reprint_settings), callbacks.onSettings)
                    PrimaryButton(stringResource(R.string.common_retry), callbacks.onRetry)
                    if (state.pendingJobId != null) SecondaryButton(stringResource(R.string.site_reprint_cancel_job), callbacks.onCancel)
                }
                else -> {
                    Icon(Icons.Outlined.QrCodeScanner, null, tint = c.accent, modifier = Modifier.size(36.dp))
                    Text(stringResource(R.string.site_reprint_scan), style = MarkiroTheme.type.title, color = c.fg1)
                    Text(stringResource(R.string.site_reprint_scan_body), style = MarkiroTheme.type.body, color = c.fg2)
                    Spacer(Modifier.weight(1f))
                    when (val result = state.result) {
                        is SiteReprintResult.Printed -> Column(Modifier.fillMaxWidth().background(c.surfaceCard, RoundedCornerShape(MarkiroSizes.radius)).padding(12.dp).semantics { liveRegion = LiveRegionMode.Polite }, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                Icon(Icons.Outlined.CheckCircle, null, tint = c.accent)
                                Text(stringResource(R.string.site_reprint_printed), style = MarkiroTheme.type.strong, color = c.fg1)
                            }
                            Text(result.description, style = MarkiroTheme.type.body, color = c.fg2)
                        }
                        SiteReprintResult.NotFound -> Banner(stringResource(R.string.site_reprint_not_found), Tone.Warn, Icons.Outlined.SearchOff)
                        is SiteReprintResult.Unavailable -> Banner(stringResource(problemText(result.code)), Tone.Warn, Icons.Outlined.Warning)
                        SiteReprintResult.Busy -> Banner(stringResource(R.string.site_reprint_busy_scan), Tone.Warn, Icons.Outlined.Schedule)
                        else -> Text(stringResource(R.string.site_reprint_any_device), style = MarkiroTheme.type.caption, color = c.fg2)
                    }
                    SecondaryButton(stringResource(R.string.site_reprint_manual), callbacks.onManual)
                }
            }
            if (state.busyScan) Box(Modifier.semantics { liveRegion = LiveRegionMode.Assertive }) {
                Banner(stringResource(R.string.site_reprint_busy_scan), Tone.Warn, Icons.Outlined.Schedule)
            }
        }
    }
    if (retryUnknown) AlertDialog(onDismissRequest = { retryUnknown = false },
        title = { Text(stringResource(R.string.site_reprint_retry_unknown)) },
        text = { Text(stringResource(R.string.site_reprint_retry_warning)) },
        confirmButton = { TextButton(onClick = { retryUnknown = false; callbacks.onRetry() }) { Text(stringResource(R.string.site_reprint_retry_unknown)) } },
        dismissButton = { TextButton(onClick = { retryUnknown = false }) { Text(stringResource(R.string.common_cancel)) } },
        containerColor = c.surfacePanel)
}

private fun reasonText(reason: String): Int = when (reason) {
    "not_printed" -> R.string.site_reprint_reason_not_printed
    "damaged" -> R.string.site_reprint_reason_damaged
    else -> R.string.site_reprint_reason_lost
}
private fun isConfiguration(code: String) = code in setOf("printer_unconfigured", "template_unconfigured", "template_incompatible", "template_invalid", "template_missing", "printer_missing")
private fun problemText(code: String): Int = when {
    isConfiguration(code) -> R.string.site_reprint_configuration_missing
    code == "verification_mismatch" -> R.string.site_reprint_verify_mismatch
    code == "pending_other_operator" -> R.string.site_reprint_other_operator
    code == "operator_changed" -> R.string.site_reprint_operator_changed
    code == "saved_unreadable" -> R.string.site_reprint_unreadable
    code == "no_paper" -> R.string.site_reprint_no_paper
    code == "incomplete_km" -> R.string.site_reprint_incomplete
    code in setOf("source_not_printable", "composition_changed", "snapshot_missing", "source_fields_missing", "not_closed", "ambiguous", "ownership_conflict", "not_production", "unsupported_pallet") -> R.string.site_reprint_refused
    code == "not_found" -> R.string.site_reprint_not_found
    code in setOf("released", "disassembled", "source_unavailable", "unit_released", "box_disassembled", "pallet_disassembled") -> R.string.site_reprint_source_unavailable
    else -> R.string.site_reprint_unavailable
}
