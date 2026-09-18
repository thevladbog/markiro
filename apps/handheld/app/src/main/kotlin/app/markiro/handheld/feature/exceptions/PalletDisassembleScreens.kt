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
import androidx.compose.ui.res.pluralStringResource
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

data class PalletDisassembleCallbacks(
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
 * Scan the pallet label, choose a reason, confirm — the same three steps
 * `DisassembleScreen` walks a box through, and deliberately the same shape, so
 * an operator who has taken a box apart recognises this screen.
 *
 * The confirmation names the pallet's own number and how many boxes come off
 * it: a stack is taken apart by hand afterwards, and the count is what the
 * operator checks against what is actually in front of them.
 */
@Composable
fun PalletDisassembleScreen(step: PalletDisassembleStep, cb: PalletDisassembleCallbacks) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    when (step) {
        PalletDisassembleStep.ScanPallet -> Column(Modifier.fillMaxSize().background(c.surfacePage)) {
            AppBar(stringResource(R.string.exceptions_disassemble_pallet), onBack = cb.onBack)
            Text(
                stringResource(R.string.disassemble_step, 1),
                style = t.caption,
                color = c.tone(Tone.Accent).fg,
                modifier = Modifier.padding(horizontal = MarkiroSizes.sp4, vertical = MarkiroSizes.sp2),
            )
            FullScreenState(
                icon = Icons.Outlined.QrCodeScanner,
                title = "",
                text = stringResource(R.string.pallet_disassemble_scan_hint),
                secondary = StateAction(stringResource(R.string.common_cancel), cb.onBack),
            )
        }

        is PalletDisassembleStep.Reason -> Column(Modifier.fillMaxSize().background(c.surfacePage)) {
            AppBar(stringResource(R.string.exceptions_disassemble_pallet), onBack = cb.onCancel)
            Column(
                Modifier.padding(MarkiroSizes.sp4),
                verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2),
            ) {
                Text(stringResource(R.string.disassemble_step, 2), style = t.caption, color = c.tone(Tone.Accent).fg)
                Text(stringResource(R.string.disassemble_reason_title), style = t.title, color = c.fg1)
                Text(
                    pluralStringResource(R.plurals.pallet_disassemble_context, step.boxCount, step.sscc.takeLast(TAIL), step.boxCount),
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

        is PalletDisassembleStep.Confirm -> FullScreenState(
            icon = Icons.Outlined.Warning,
            title = stringResource(R.string.exceptions_disassemble_pallet),
            text = pluralStringResource(
                R.plurals.pallet_disassemble_confirm_body,
                step.boxCount,
                step.sscc.takeLast(TAIL),
                step.boxCount,
            ),
            primary = StateAction(stringResource(R.string.exceptions_confirm), cb.onConfirm),
            secondary = StateAction(stringResource(R.string.common_cancel), cb.onCancel),
            tone = Tone.Err,
            primaryIsAccent = false,
        )

        PalletDisassembleStep.Retired -> FullScreenState(
            icon = Icons.Outlined.CheckCircle,
            title = stringResource(R.string.pallet_disassemble_done),
            text = "",
            primary = StateAction(stringResource(R.string.common_got_it), cb.onDone),
            tone = Tone.Ok,
        )

        is PalletDisassembleStep.Refused -> FullScreenState(
            icon = Icons.Outlined.Warning,
            title = stringResource(step.message),
            text = "",
            primary = StateAction(stringResource(R.string.common_got_it), cb.onCancel),
            tone = Tone.Warn,
        )
    }
}

/** The label's last six digits: what the operator can read off the printed number. */
private const val TAIL = 6
