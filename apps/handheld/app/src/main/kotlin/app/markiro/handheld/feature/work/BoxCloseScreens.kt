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
import app.markiro.handheld.core.box.CloseResult
import app.markiro.handheld.core.box.PrintReason
import app.markiro.handheld.core.design.MarkiroSizes
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.design.PrimaryButton
import app.markiro.handheld.core.design.SecondaryButton
import app.markiro.handheld.core.design.MarkiroTextButton
import app.markiro.handheld.core.design.Tone
import app.markiro.handheld.core.design.tone

data class BoxCloseCallbacks(
    val onRetry: () -> Unit = {},
    val onOtherPrinter: () -> Unit = {},
    val onDefer: () -> Unit = {},
    val onConfirmPrinted: () -> Unit = {},
    val onDismiss: () -> Unit = {},
)

/** How long a clean print stays on screen before the next box starts. */
private const val PRINTED_DWELL_MS = 1_000L

/** The operator-facing name for a print failure. Never a raw code. */
fun printReasonLabel(reason: String): Int = when (reason) {
    PrintReason.NO_PAPER -> R.string.print_reason_no_paper
    PrintReason.HEAD_OPEN -> R.string.print_reason_head_open
    PrintReason.UNREACHABLE -> R.string.print_reason_unreachable
    PrintReason.PRINTER_UNCONFIGURED -> R.string.print_reason_printer_unconfigured
    PrintReason.TEMPLATE_MISSING -> R.string.print_reason_template_missing
    PrintReason.TEMPLATE_INVALID -> R.string.print_reason_template_invalid
    PrintReason.RENDER_FAILED -> R.string.print_reason_render_failed
    PrintReason.TRANSPORT_FAILED -> R.string.print_reason_transport_failed
    else -> R.string.print_reason_other
}

/**
 * The full-screen state a closed box gets.
 *
 * `Printed` dismisses itself so the next box can start; every other state waits
 * for a person, because each one is a decision only they can make.
 */
@Composable
fun BoxCloseScreen(step: BoxCloseStep, cb: BoxCloseCallbacks) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    if (step is BoxCloseStep.Printed) {
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
            BoxCloseStep.Idle -> Unit
            is BoxCloseStep.Refused -> Refused(step.reason, cb)
            is BoxCloseStep.Printing -> {
                Header(step.box)
                CircularProgressIndicator(color = c.accent)
                Spacer(Modifier.size(MarkiroSizes.sp3))
                Text(stringResource(R.string.box_close_printing), style = t.body, color = c.fg2)
            }
            is BoxCloseStep.Printed -> {
                Header(step.box)
                Text(stringResource(R.string.box_close_printed), style = t.title, color = c.tone(Tone.Ok).fg)
            }
            is BoxCloseStep.Failed -> {
                Header(step.box)
                Text(stringResource(R.string.box_close_failed), style = t.title, color = c.tone(Tone.Err).fg)
                Text(stringResource(printReasonLabel(step.reason)), style = t.body, color = c.fg2)
                Spacer(Modifier.size(MarkiroSizes.sp4))
                Actions {
                    PrimaryButton(stringResource(R.string.box_close_retry), cb.onRetry)
                    SecondaryButton(stringResource(R.string.box_close_other_printer), cb.onOtherPrinter)
                    MarkiroTextButton(stringResource(R.string.box_close_defer), cb.onDefer)
                }
            }
            is BoxCloseStep.Unknown -> {
                Header(step.box)
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
                    // second label on a box the server has already accepted.
                    PrimaryButton(stringResource(R.string.box_close_confirm_printed), cb.onConfirmPrinted)
                    SecondaryButton(stringResource(R.string.box_close_print_again), cb.onRetry)
                    MarkiroTextButton(stringResource(R.string.box_close_defer), cb.onDefer)
                }
            }
        }
    }
}

@Composable
private fun Header(box: ClosedBoxUi) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Text(
        stringResource(R.string.box_close_title, box.ordinal),
        style = t.title,
        color = c.fg1,
        textAlign = TextAlign.Center,
    )
    Text(box.sscc, style = t.code, color = c.fg1)
    Text(stringResource(R.string.box_close_units, box.itemCount), style = t.caption, color = c.fg3)
    Spacer(Modifier.size(MarkiroSizes.sp4))
}

/**
 * A box that did not close at all.
 *
 * Each reason names what the operator can do next, because «не получилось» is
 * not a next step: a dry pool needs the network, an invalid serial needs
 * another attempt, and an empty box needs nothing.
 */
@Composable
private fun Refused(reason: CloseResult, cb: BoxCloseCallbacks) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    val (title, hint) = when (reason) {
        CloseResult.NoSerials -> R.string.box_refused_no_serials to R.string.box_refused_no_serials_hint
        CloseResult.InvalidSerial -> R.string.box_refused_invalid_serial to R.string.box_refused_invalid_serial_hint
        CloseResult.NoIssuer -> R.string.box_refused_no_issuer to null
        else -> R.string.box_refused_empty to null
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
