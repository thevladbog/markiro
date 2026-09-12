package app.markiro.handheld.feature.work

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import app.markiro.handheld.R
import app.markiro.handheld.core.box.ClosePalletResult
import app.markiro.handheld.core.design.MarkiroSizes
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.design.PrimaryButton
import app.markiro.handheld.core.design.SecondaryButton
import app.markiro.handheld.core.design.MarkiroTextButton
import app.markiro.handheld.core.design.Tone
import app.markiro.handheld.core.design.tone

data class PalletCloseCallbacks(
    val onRetry: () -> Unit = {},
    val onOtherPrinter: () -> Unit = {},
    val onDefer: () -> Unit = {},
    val onConfirmPrinted: () -> Unit = {},
    val onDismiss: () -> Unit = {},
)

/** How long a clean print stays on screen before the pallet screen gives way to whatever is under it. */
private const val PRINTED_DWELL_MS = 1_000L

/**
 * The full-screen state a closed pallet gets.
 *
 * Mirrors `BoxCloseScreen` down to the shared print-recovery strings (brief
 * 10 §6: pallet completion mirrors box completion) -- only the title, the
 * count line and the refusal reasons that name «короб»/«паллета» are
 * pallet-specific; the rest of the label vocabulary is generic to "a label",
 * not to a box.
 */
@Composable
fun PalletCloseScreen(step: PalletCloseStep, cb: PalletCloseCallbacks) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    if (step is PalletCloseStep.Printed) {
        LaunchedEffect(step) {
            kotlinx.coroutines.delay(PRINTED_DWELL_MS)
            cb.onDismiss()
        }
    }
    Column(
        Modifier.fillMaxSize().background(c.surfacePage).padding(MarkiroSizes.sp4),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        when (step) {
            PalletCloseStep.Idle -> Unit
            is PalletCloseStep.Refused -> Refused(step.reason, cb)
            is PalletCloseStep.Printing -> {
                Header(step.pallet)
                CircularProgressIndicator(color = c.accent)
                Spacer(Modifier.size(MarkiroSizes.sp3))
                Text(stringResource(R.string.box_close_printing), style = t.body, color = c.fg2)
            }
            is PalletCloseStep.Printed -> {
                Header(step.pallet)
                Text(stringResource(R.string.box_close_printed), style = t.title, color = c.tone(Tone.Ok).fg)
            }
            is PalletCloseStep.Failed -> {
                Header(step.pallet)
                Text(stringResource(R.string.box_close_failed), style = t.title, color = c.tone(Tone.Err).fg)
                Text(stringResource(printReasonLabel(step.reason)), style = t.body, color = c.fg2)
                Spacer(Modifier.size(MarkiroSizes.sp4))
                Actions {
                    PrimaryButton(stringResource(R.string.box_close_retry), cb.onRetry)
                    SecondaryButton(stringResource(R.string.box_close_other_printer), cb.onOtherPrinter)
                    MarkiroTextButton(stringResource(R.string.box_close_defer), cb.onDefer)
                }
            }
            is PalletCloseStep.Unknown -> {
                Header(step.pallet)
                Text(stringResource(R.string.box_close_unknown), style = t.title, color = c.tone(Tone.Warn).fg)
                Text(
                    stringResource(R.string.box_close_unknown_hint),
                    style = t.body,
                    color = c.fg2,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.size(MarkiroSizes.sp4))
                Actions {
                    // Nothing here resends on its own: an automatic retry could put a
                    // second label on a pallet the server has already accepted.
                    PrimaryButton(stringResource(R.string.box_close_confirm_printed), cb.onConfirmPrinted)
                    SecondaryButton(stringResource(R.string.box_close_print_again), cb.onRetry)
                    MarkiroTextButton(stringResource(R.string.box_close_defer), cb.onDefer)
                }
            }
        }
    }
}

@Composable
private fun Header(pallet: ClosedPalletUi) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Text(
        stringResource(R.string.pallet_close_title),
        style = t.title,
        color = c.fg1,
        textAlign = TextAlign.Center,
    )
    Text(pallet.sscc, style = t.code, color = c.fg1)
    Text(stringResource(R.string.pallet_close_boxes, pallet.boxCount), style = t.caption, color = c.fg3)
    Spacer(Modifier.size(MarkiroSizes.sp4))
}

/**
 * A pallet that did not close at all.
 *
 * Each reason names what the operator can do next, the same discipline
 * `BoxCloseScreen`'s own `Refused` holds: «не получилось» is not a next step.
 */
@Composable
private fun Refused(reason: ClosePalletResult, cb: PalletCloseCallbacks) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    val (title, hint) = when (reason) {
        ClosePalletResult.NoSerials -> R.string.box_refused_no_serials to R.string.pallet_refused_no_serials_hint
        ClosePalletResult.InvalidSerial -> R.string.box_refused_invalid_serial to R.string.pallet_refused_invalid_serial_hint
        ClosePalletResult.NoIssuer -> R.string.box_refused_no_issuer to null
        else -> R.string.pallet_refused_empty to null
    }
    Text(stringResource(title), style = t.title, color = c.tone(Tone.Warn).fg, textAlign = TextAlign.Center)
    hint?.let {
        Spacer(Modifier.size(MarkiroSizes.sp2))
        Text(stringResource(it), style = t.body, color = c.fg2, textAlign = TextAlign.Center)
    }
    Spacer(Modifier.size(MarkiroSizes.sp4))
    Actions { PrimaryButton(stringResource(R.string.box_refused_dismiss), cb.onDismiss) }
}

@Composable
private fun Actions(content: @Composable () -> Unit) {
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 8.dp),
        verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) { content() }
}
