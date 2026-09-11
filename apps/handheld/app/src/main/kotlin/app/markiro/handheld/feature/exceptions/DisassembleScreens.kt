package app.markiro.handheld.feature.exceptions

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Inventory2
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material.icons.outlined.Warning
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
import app.markiro.handheld.core.exceptions.DisassembleReason

data class DisassembleCallbacks(
    val onBack: () -> Unit = {},
    val onReason: (DisassembleReason) -> Unit = {},
    val onConfirm: () -> Unit = {},
    val onCancel: () -> Unit = {},
    val onDone: () -> Unit = {},
)

/** The localized label for a reason; the value sent to the server stays `reason.audit`. */
private fun labelOf(reason: DisassembleReason): Int = when (reason) {
    DisassembleReason.WRONG_PRODUCT -> R.string.reason_wrong_product
    DisassembleReason.WRONG_QUANTITY -> R.string.reason_wrong_quantity
    DisassembleReason.DAMAGED_PACKAGE -> R.string.reason_damaged_package
    DisassembleReason.QUALITY_REJECTED -> R.string.reason_quality_rejected
}

/**
 * Scan the label, choose a reason, confirm.
 *
 * The step header is the operator's only sense of how far this goes, and the
 * third step states plainly that the number is retired — this is the one action
 * on the device that cannot be taken back.
 */
@Composable
fun DisassembleScreen(step: DisassembleStep, cb: DisassembleCallbacks) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    when (step) {
        DisassembleStep.ScanBox -> Column(Modifier.fillMaxSize().background(c.surfacePage)) {
            AppBar(stringResource(R.string.exceptions_disassemble), onBack = cb.onBack)
            Text(
                stringResource(R.string.disassemble_step, 1),
                style = t.caption,
                color = c.tone(Tone.Accent).fg,
                modifier = Modifier.padding(horizontal = MarkiroSizes.sp4, vertical = MarkiroSizes.sp2),
            )
            FullScreenState(
                icon = Icons.Outlined.QrCodeScanner,
                title = stringResource(R.string.disassemble_scan_title),
                text = stringResource(R.string.disassemble_scan_body),
                secondary = StateAction(stringResource(R.string.common_cancel), cb.onBack),
            )
        }

        is DisassembleStep.Reason -> Column(Modifier.fillMaxSize().background(c.surfacePage)) {
            AppBar(stringResource(R.string.exceptions_disassemble), onBack = cb.onCancel)
            Column(
                Modifier.padding(MarkiroSizes.sp4),
                verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2),
            ) {
                Text(stringResource(R.string.disassemble_step, 2), style = t.caption, color = c.tone(Tone.Accent).fg)
                Text(stringResource(R.string.disassemble_reason_title), style = t.title, color = c.fg1)
                Text(
                    stringResource(R.string.disassemble_context, step.ordinal, step.units),
                    style = t.body,
                    color = c.fg2,
                )
                for (reason in DisassembleReason.entries) {
                    ActionRow(
                        icon = Icons.Outlined.Inventory2,
                        label = stringResource(labelOf(reason)),
                        enabled = true,
                        unavailable = "",
                        onClick = { cb.onReason(reason) },
                    )
                }
            }
        }

        is DisassembleStep.Confirm -> FullScreenState(
            icon = Icons.Outlined.Warning,
            title = stringResource(R.string.disassemble_confirm_title, step.ordinal),
            text = stringResource(R.string.disassemble_confirm_body, step.units, step.sscc),
            primary = StateAction(stringResource(R.string.exceptions_confirm), cb.onConfirm),
            secondary = StateAction(stringResource(R.string.common_cancel), cb.onCancel),
            tone = Tone.Err,
            primaryIsAccent = false,
        )

        DisassembleStep.Retired -> FullScreenState(
            icon = Icons.Outlined.CheckCircle,
            title = stringResource(R.string.disassemble_done),
            text = "",
            primary = StateAction(stringResource(R.string.common_cancel), cb.onDone),
            tone = Tone.Ok,
        )

        is DisassembleStep.Refused -> FullScreenState(
            icon = Icons.Outlined.Warning,
            title = stringResource(step.message),
            text = "",
            primary = StateAction(stringResource(R.string.common_cancel), cb.onCancel),
            tone = Tone.Warn,
        )
    }
}
