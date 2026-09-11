package app.markiro.handheld.feature.exceptions

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Print
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import app.markiro.handheld.R
import app.markiro.handheld.core.design.AppBar
import app.markiro.handheld.core.design.FullScreenState
import app.markiro.handheld.core.design.MarkiroSizes
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.design.StateAction
import app.markiro.handheld.core.design.Tone
import app.markiro.handheld.core.design.tone
import app.markiro.handheld.core.exceptions.ReprintReason

data class ReprintCallbacks(
    val onBack: () -> Unit = {},
    val onChooseLast: () -> Unit = {},
    val onReason: (ReprintReason) -> Unit = {},
    val onCancel: () -> Unit = {},
    val onDone: () -> Unit = {},
)

/** The localized label; the value sent to the server stays `reason.audit`. */
private fun labelOf(reason: ReprintReason): Int = when (reason) {
    ReprintReason.DAMAGED_LABEL -> R.string.reason_damaged_label
    ReprintReason.UNREADABLE_LABEL -> R.string.reason_unreadable_label
    ReprintReason.PRINTER_JAM -> R.string.reason_printer_jam
    ReprintReason.QUALITY_REQUEST -> R.string.reason_quality_request
    // Never offered: written by print recovery, which asks nothing.
    ReprintReason.PRINT_OUTCOME_UNKNOWN -> R.string.reason_printer_jam
}

/** The four reasons an operator may choose. */
private val offered = listOf(
    ReprintReason.DAMAGED_LABEL,
    ReprintReason.UNREADABLE_LABEL,
    ReprintReason.PRINTER_JAM,
    ReprintReason.QUALITY_REQUEST,
)

@Composable
fun ReprintScreen(state: ReprintUi, cb: ReprintCallbacks) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    if (state.done) {
        FullScreenState(
            icon = Icons.Outlined.CheckCircle,
            title = stringResource(R.string.reprint_done),
            text = "",
            primary = StateAction(stringResource(R.string.common_cancel), cb.onDone),
            tone = Tone.Ok,
        )
        return
    }
    Column(Modifier.fillMaxSize().background(c.surfacePage)) {
        AppBar(stringResource(R.string.reprint_title), onBack = cb.onBack)
        Column(
            Modifier.padding(MarkiroSizes.sp4),
            verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2),
        ) {
            val selected = state.selected
            if (selected == null) {
                ActionRow(
                    icon = Icons.Outlined.Print,
                    label = state.last?.let { stringResource(R.string.reprint_last, it.ordinal) }
                        ?: stringResource(R.string.exceptions_no_closed_boxes),
                    enabled = state.last != null,
                    unavailable = stringResource(R.string.exceptions_no_closed_boxes),
                    onClick = cb.onChooseLast,
                )
                ActionRow(
                    icon = Icons.Outlined.QrCodeScanner,
                    label = stringResource(R.string.reprint_scan),
                    enabled = true,
                    unavailable = "",
                    onClick = {},
                )
                Text(stringResource(R.string.reprint_audit_note), style = t.caption, color = c.fg3)
                state.error?.let { Text(stringResource(it), style = t.caption, color = c.tone(Tone.Warn).fg) }
            } else {
                Text(stringResource(R.string.reprint_reason_title), style = t.title, color = c.fg1)
                Text(
                    stringResource(R.string.reprint_last, selected.ordinal),
                    style = t.body,
                    color = c.fg2,
                )
                for (reason in offered) {
                    ActionRow(
                        icon = Icons.Outlined.Print,
                        label = stringResource(labelOf(reason)),
                        enabled = true,
                        unavailable = "",
                        onClick = { cb.onReason(reason) },
                    )
                }
            }
        }
    }
}
