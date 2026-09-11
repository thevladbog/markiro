package app.markiro.handheld.feature.shift

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Factory
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.markiro.handheld.R
import app.markiro.handheld.core.design.AppBar
import app.markiro.handheld.core.design.FullScreenState
import app.markiro.handheld.core.design.MarkiroSizes
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.design.PrimaryButton
import app.markiro.handheld.core.design.StateAction
import app.markiro.handheld.core.design.Tone
import app.markiro.handheld.core.design.tone

data class CloseCallbacks(
    val onConfirm: () -> Unit = {},
    val onCancel: () -> Unit = {},
    val onSelectReason: (String) -> Unit = {},
    val onSubmitReason: () -> Unit = {},
    val onDone: () -> Unit = {},
)

fun reasonLabel(code: String): Int = when (code) {
    "production_defect" -> R.string.reason_production_defect
    "material_shortage" -> R.string.reason_material_shortage
    "equipment_stop" -> R.string.reason_equipment_stop
    "production_order_changed" -> R.string.reason_production_order_changed
    "planned_quantity_error" -> R.string.reason_planned_quantity_error
    else -> R.string.reason_other_production_deviation
}

@Composable
fun CloseScreen(step: CloseStep, cb: CloseCallbacks) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Column(Modifier.fillMaxSize().background(c.surfacePage)) {
        when (step) {
            CloseStep.Loading -> FullScreenState(Icons.Outlined.Sync, "", "", tone = Tone.Info)
            is CloseStep.Confirm -> {
                AppBar(stringResource(R.string.work_close), cb.onCancel)
                // An unresolved duplicate is said out loud and closes anyway.
                // Blocking a shift close on a printer would stop a line over a
                // sticker; the events still sync afterwards.
                val text = stringResource(R.string.close_confirm_text, step.preview.accepted, step.preview.errors, step.preview.duplicates) +
                    if (step.preview.outstandingDuplicates > 0) {
                        "\n\n" + stringResource(R.string.work_close_duplicates_outstanding, step.preview.outstandingDuplicates)
                    } else {
                        ""
                    }
                FullScreenState(
                    Icons.Outlined.Factory,
                    stringResource(R.string.close_confirm_title),
                    text,
                    primary = StateAction(stringResource(R.string.close_action), cb.onConfirm),
                    secondary = StateAction(stringResource(R.string.common_cancel), cb.onCancel),
                )
            }
            is CloseStep.Reason -> {
                AppBar(stringResource(R.string.close_reason_title), cb.onCancel)
                Column(Modifier.padding(MarkiroSizes.sp4), verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2)) {
                    Text(stringResource(R.string.close_reason_text, step.preview.plan ?: 0, step.preview.accepted), style = t.caption, color = c.fg3)
                    ShiftCloser.REASONS.forEach { code ->
                        ReasonRow(stringResource(reasonLabel(code)), selected = step.selected == code) { cb.onSelectReason(code) }
                    }
                    PrimaryButton(stringResource(R.string.close_action), cb.onSubmitReason, enabled = step.selected != null)
                }
            }
            is CloseStep.Draining -> FullScreenState(
                Icons.Outlined.Sync,
                stringResource(R.string.close_draining),
                stringResource(R.string.close_draining_left, step.pending),
                tone = Tone.Info,
            )
            is CloseStep.Summary -> {
                AppBar(stringResource(R.string.close_summary_title))
                Column(Modifier.padding(MarkiroSizes.sp4), verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3)) {
                    SummaryRow(stringResource(R.string.close_summary_accepted), step.accepted.toString())
                    SummaryRow(stringResource(R.string.close_summary_errors), step.errors.toString())
                    SummaryRow(stringResource(R.string.close_summary_duplicates), step.duplicates.toString())
                    SummaryRow(stringResource(R.string.close_summary_conflicts), step.conflicts.toString())
                    val (note, noteTone) = when (step.outcome) {
                        CloseOutcome.ACCEPTED -> R.string.close_summary_title to Tone.Ok
                        CloseOutcome.CONFLICT -> R.string.close_summary_conflict to Tone.Warn
                        CloseOutcome.PENDING -> R.string.close_summary_pending to Tone.Info
                    }
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2)) {
                        Icon(Icons.Outlined.CheckCircle, contentDescription = null, tint = c.tone(noteTone).fg)
                        Text(stringResource(note), style = t.body, color = c.tone(noteTone).fg)
                    }
                    PrimaryButton(stringResource(R.string.close_to_hub), cb.onDone)
                }
            }
        }
    }
}

@Composable
private fun ReasonRow(label: String, selected: Boolean, onClick: () -> Unit) {
    val c = MarkiroTheme.colors
    val shape = RoundedCornerShape(MarkiroSizes.radius)
    Row(
        Modifier.fillMaxWidth().height(MarkiroSizes.controlRow).clip(shape).background(c.surfaceCard)
            .border(1.dp, if (selected) c.accent else c.line, shape).clickable(onClick = onClick).padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3),
    ) {
        Box(
            Modifier.size(22.dp).clip(CircleShape).border(2.dp, if (selected) c.accent else c.lineStrong, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            if (selected) Box(Modifier.size(10.dp).clip(CircleShape).background(c.accent))
        }
        Text(label, style = MarkiroTheme.type.body, color = c.fg1)
    }
}

@Composable
private fun SummaryRow(label: String, value: String) {
    val c = MarkiroTheme.colors
    Row(Modifier.fillMaxWidth().height(40.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = MarkiroTheme.type.body, color = c.fg1)
        Text(value, style = MarkiroTheme.type.code.copy(fontSize = 18.sp), color = c.fg1)
    }
}
