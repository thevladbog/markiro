package app.markiro.handheld.feature.work

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import app.markiro.handheld.R
import app.markiro.handheld.core.design.MarkiroSizes
import app.markiro.handheld.core.design.MarkiroTextButton
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.design.PrimaryButton
import app.markiro.handheld.core.design.SecondaryButton
import app.markiro.handheld.core.design.Tone
import app.markiro.handheld.core.design.tone
import app.markiro.handheld.core.duplicate.DuplicateReason
import app.markiro.handheld.core.duplicate.ReprintReason

sealed interface DuplicateStep {
    data object Idle : DuplicateStep
    data class Awaiting(val jobId: String, val tail: String) : DuplicateStep
    data class Verified(val jobId: String) : DuplicateStep

    /**
     * Nothing was printed and we know why.
     *
     * `jobId` is null when the refusal came BEFORE a job existed -- the unit was
     * accepted, but preparation never got as far as a row. There is nothing to
     * retry or reprint then, and offering either gave the operator buttons that
     * silently did nothing.
     */
    data class Failed(val jobId: String?, val reason: String) : DuplicateStep

    /** The bytes may or may not have reached the printer. */
    data class Unknown(val jobId: String, val cause: String) : DuplicateStep

    /** The scanned sticker was not this unit's, or would not read. */
    data class Rejected(val jobId: String, val mismatch: Boolean) : DuplicateStep

    fun jobId(): String? = when (this) {
        is Awaiting -> jobId
        is Verified -> jobId
        is Failed -> jobId
        is Unknown -> jobId
        is Rejected -> jobId
        Idle -> null
    }
}

data class DuplicateCallbacks(
    val onRetry: () -> Unit = {},
    val onReprint: (String) -> Unit = {},
    val onScanAgain: () -> Unit = {},
    val onDismiss: () -> Unit = {},
    val onSkip: () -> Unit = {},
)

/** The operator-facing name for a duplicate failure. Never a raw code. */
fun duplicateReasonLabel(reason: String): Int = when (reason) {
    DuplicateReason.NO_PAPER -> R.string.print_reason_no_paper
    DuplicateReason.HEAD_OPEN -> R.string.print_reason_head_open
    DuplicateReason.UNREACHABLE -> R.string.print_reason_unreachable
    DuplicateReason.TRANSPORT_FAILED -> R.string.print_reason_transport_failed
    DuplicateReason.PRINTER_UNCONFIGURED -> R.string.print_reason_printer_unconfigured
    DuplicateReason.PRINTER_CHANGED -> R.string.duplicate_reason_printer_changed
    DuplicateReason.TEMPLATE_MISSING -> R.string.print_reason_template_missing
    DuplicateReason.TEMPLATE_INVALID -> R.string.print_reason_template_invalid
    DuplicateReason.RENDER_FAILED -> R.string.print_reason_render_failed
    DuplicateReason.CODE_INCOMPLETE -> R.string.duplicate_reason_code_incomplete
    DuplicateReason.BYTES_GONE -> R.string.duplicate_reason_bytes_gone
    DuplicateReason.ATTEMPT_IN_FLIGHT -> R.string.duplicate_reason_attempt_in_flight
    DuplicateReason.POLICY_INCOMPLETE -> R.string.duplicate_reason_policy_incomplete
    else -> R.string.print_reason_other
}

@Composable
fun DuplicateScreen(step: DuplicateStep, cb: DuplicateCallbacks) {
    if (step is DuplicateStep.Awaiting || step is DuplicateStep.Verified) {
        VerificationScreen(step, cb)
        return
    }
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    val tone = c.tone(if (step is DuplicateStep.Failed) Tone.Err else Tone.Warn)
    Column(
        Modifier.fillMaxSize().background(tone.bg).padding(MarkiroSizes.sp4),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        when (step) {
            DuplicateStep.Idle, is DuplicateStep.Awaiting, is DuplicateStep.Verified -> Unit

            is DuplicateStep.Failed -> {
                Text(stringResource(R.string.duplicate_failed_title), style = t.title, color = tone.fg, textAlign = TextAlign.Center)
                Text(
                    stringResource(duplicateReasonLabel(step.reason)),
                    style = t.strong,
                    color = c.fg1,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(top = MarkiroSizes.sp2),
                )
                Spacer(Modifier.padding(MarkiroSizes.sp2))
                if (step.jobId != null) {
                    PrimaryButton(stringResource(R.string.duplicate_retry), cb.onRetry)
                    ReprintReasons(cb)
                } else {
                    Text(
                        stringResource(R.string.duplicate_unprepared_hint),
                        style = t.strong,
                        color = c.fg2,
                        textAlign = TextAlign.Center,
                    )
                }
            }

            is DuplicateStep.Unknown -> {
                Text(stringResource(R.string.duplicate_unknown_title), style = t.title, color = tone.fg, textAlign = TextAlign.Center)
                // The scan leads, not the reprint. Under a `none` policy this is
                // the only place a verification scan is ever offered, so the
                // screen has to say what the trigger pull will do.
                Text(
                    stringResource(R.string.duplicate_unknown_scan_hint),
                    style = t.strong,
                    color = c.fg1,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(top = MarkiroSizes.sp2),
                )
                Text(
                    stringResource(R.string.duplicate_unknown_cause, step.cause),
                    style = t.caption,
                    color = c.fg2,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(top = MarkiroSizes.sp1),
                )
                Spacer(Modifier.padding(MarkiroSizes.sp2))
                ReprintReasons(cb)
            }

            is DuplicateStep.Rejected -> {
                Text(stringResource(R.string.duplicate_rejected_title), style = t.title, color = tone.fg, textAlign = TextAlign.Center)
                Text(
                    stringResource(
                        if (step.mismatch) R.string.duplicate_rejected_mismatch else R.string.duplicate_rejected_invalid,
                    ),
                    style = t.strong,
                    color = c.fg1,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(top = MarkiroSizes.sp2),
                )
                Spacer(Modifier.padding(MarkiroSizes.sp2))
                PrimaryButton(stringResource(R.string.duplicate_scan_again), cb.onScanAgain)
                ReprintReasons(cb)
            }
        }
        Spacer(Modifier.padding(MarkiroSizes.sp1))
        MarkiroTextButton(stringResource(R.string.duplicate_dismiss), cb.onDismiss)
    }
}

/** Three reasons, because the cabinet tells them apart and an operator can too. */
@Composable
private fun ReprintReasons(cb: DuplicateCallbacks) {
    Column(Modifier.fillMaxWidth().padding(top = MarkiroSizes.sp2), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SecondaryButton(stringResource(R.string.duplicate_reprint_not_printed), { cb.onReprint(ReprintReason.NOT_PRINTED) })
        SecondaryButton(stringResource(R.string.duplicate_reprint_damaged), { cb.onReprint(ReprintReason.DAMAGED) })
        SecondaryButton(stringResource(R.string.duplicate_reprint_lost), { cb.onReprint(ReprintReason.LOST) })
    }
}


/** The scanner remains owned by the work route while this screen explains its new purpose. */
@Composable
private fun VerificationScreen(step: DuplicateStep, cb: DuplicateCallbacks) {
    val verified = step is DuplicateStep.Verified
    val colors = MarkiroTheme.colors.tone(if (verified) Tone.Ok else Tone.Warn)
    val type = MarkiroTheme.type
    var problems by remember(step.jobId()) { mutableStateOf(false) }
    // Back may close the problem choices, but cannot silently bypass verification.
    BackHandler { problems = false }
    Column(Modifier.fillMaxSize().background(colors.solid).padding(MarkiroSizes.sp4)) {
        Box(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp4)) {
                Icon(if (verified) Icons.Outlined.CheckCircle else Icons.Outlined.QrCodeScanner,
                    contentDescription = null, tint = colors.onSolid, modifier = Modifier.size(72.dp))
                Text(stringResource(if (verified) R.string.duplicate_verified_title else R.string.duplicate_verify_title),
                    style = type.title, color = colors.onSolid, textAlign = TextAlign.Center)
                if (step is DuplicateStep.Awaiting) Text(step.tail, style = type.code, color = colors.onSolid)
                Text(stringResource(if (verified) R.string.duplicate_verified_hint else R.string.duplicate_verify_hint),
                    style = type.body, color = colors.onSolid, textAlign = TextAlign.Center)
            }
        }
        if (!verified) {
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2)) {
                if (problems) {
                    ReprintReasons(cb)
                    SecondaryButton(stringResource(R.string.duplicate_return_to_scan), { problems = false })
                } else {
                    SecondaryButton(stringResource(R.string.duplicate_label_problem), { problems = true })
                    SecondaryButton(stringResource(R.string.duplicate_skip_verification), cb.onSkip)
                }
            }
        }
    }
}
