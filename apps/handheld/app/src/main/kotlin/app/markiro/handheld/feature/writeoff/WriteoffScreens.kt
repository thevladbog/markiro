package app.markiro.handheld.feature.writeoff

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.Inventory2
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material.icons.outlined.RemoveShoppingCart
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.markiro.handheld.R
import app.markiro.handheld.core.design.AppBar
import app.markiro.handheld.core.design.Banner
import app.markiro.handheld.core.design.DestructiveButton
import app.markiro.handheld.core.design.FullScreenState
import app.markiro.handheld.core.design.IconAction
import app.markiro.handheld.core.design.MarkiroChip
import app.markiro.handheld.core.design.MarkiroSizes
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.design.PrimaryButton
import app.markiro.handheld.core.design.ScreenColumn
import app.markiro.handheld.core.design.SecondaryButton
import app.markiro.handheld.core.design.StateAction
import app.markiro.handheld.core.design.Tone
import app.markiro.handheld.core.design.tone
import app.markiro.handheld.core.storage.WriteoffReasonEntity
import app.markiro.handheld.core.util.TimeText

/**
 * The whole mode: one screen per step, chosen by state rather than by route, so
 * hardware Back is a step inside the mode and not an exit from it.
 *
 * There is no full-screen scan overlay here on purpose. In a shift the operator's
 * eyes are on the conveyor; during a write-off they are on the list, and a
 * full-screen flash per scan would be noise. The compact verdict is the signal.
 */
@Composable
fun WriteoffRoute(
    state: WriteoffUi,
    onBack: () -> Unit,
    onHistory: () -> Unit,
    onRemove: (WriteoffLine) -> Unit,
    onNext: () -> Unit,
    onSelectReason: (WriteoffReasonEntity) -> Unit,
    onToConfirm: () -> Unit,
    onConfirm: () -> Unit,
    onStepBack: () -> Unit,
    onAnother: () -> Unit,
    onDismissDiscard: () -> Unit,
) {
    state.blocked?.let { return WriteoffBlockedScreen(it, onBack) }
    if (state.confirmDiscard) {
        AlertDialog(
            onDismissRequest = onDismissDiscard,
            title = { Text(stringResource(R.string.writeoff_discard_title), color = MarkiroTheme.colors.fg1) },
            text = { Text(stringResource(R.string.writeoff_discard_text), color = MarkiroTheme.colors.fg2) },
            confirmButton = { TextButton(onClick = onBack) { Text(stringResource(R.string.writeoff_discard_confirm)) } },
            dismissButton = { TextButton(onClick = onDismissDiscard) { Text(stringResource(R.string.common_cancel)) } },
            containerColor = MarkiroTheme.colors.surfacePanel,
        )
    }
    when (state.step) {
        WriteoffStep.LIST -> WriteoffListScreen(state, onBack, onHistory, onRemove, onNext)
        WriteoffStep.REASON -> WriteoffReasonScreen(state, onStepBack, onSelectReason, onToConfirm)
        WriteoffStep.CONFIRM -> WriteoffConfirmScreen(state, onStepBack, onConfirm)
        WriteoffStep.RESULT -> WriteoffResultScreen(state, onBack, onAnother)
    }
}

@Composable
private fun WriteoffBlockedScreen(blocked: Blocked, onBack: () -> Unit) {
    val (title, text) = when (blocked) {
        Blocked.NO_PERMISSION -> R.string.writeoff_blocked_permission_title to R.string.writeoff_blocked_permission_text
        Blocked.NO_REASONS -> R.string.writeoff_blocked_reasons_title to R.string.writeoff_blocked_reasons_text
        Blocked.NEVER_SYNCED -> R.string.writeoff_blocked_sync_title to R.string.writeoff_blocked_sync_text
    }
    FullScreenState(
        icon = Icons.Outlined.Warning,
        title = stringResource(title),
        text = stringResource(text),
        primary = StateAction(stringResource(R.string.writeoff_to_hub), onBack),
        tone = Tone.Warn,
    )
}

@Composable
private fun WriteoffListScreen(
    state: WriteoffUi,
    onBack: () -> Unit,
    onHistory: () -> Unit,
    onRemove: (WriteoffLine) -> Unit,
    onNext: () -> Unit,
) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Column(Modifier.fillMaxWidth().background(c.surfacePage)) {
        AppBar(stringResource(R.string.writeoff_title), onBack = onBack) {
            IconAction(Icons.Outlined.History, stringResource(R.string.writeoff_history_title), onHistory)
        }
        state.stampAt?.let {
            Text(
                stringResource(R.string.common_data_as_of, TimeText.hhmm(it)),
                style = t.caption,
                color = c.fg3,
                modifier = Modifier.padding(horizontal = MarkiroSizes.sp4, vertical = MarkiroSizes.sp1),
            )
        }
        state.lastVerdict?.let { VerdictRow(it) }
        if (state.lines.isEmpty()) {
            FullScreenState(
                icon = Icons.Outlined.QrCodeScanner,
                title = stringResource(R.string.writeoff_empty_title),
                text = stringResource(R.string.writeoff_empty_text),
            )
            return@Column
        }
        ScreenColumn(
            padding = PaddingValues(MarkiroSizes.sp4),
            verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2),
        ) {
            Text(
                stringResource(
                    R.string.writeoff_counters,
                    pluralStringResource(R.plurals.writeoff_units, state.unitCount, state.unitCount),
                    pluralStringResource(R.plurals.writeoff_boxes, state.boxCount, state.boxCount),
                ),
                style = t.caption,
                color = c.fg3,
            )
            state.lines.asReversed().forEach { line -> LineRow(line) { onRemove(line) } }
            Spacer(Modifier.height(MarkiroSizes.sp2))
            PrimaryButton(stringResource(R.string.writeoff_next), onNext, enabled = state.lines.isNotEmpty())
        }
    }
}

@Composable
private fun VerdictRow(verdict: Verdict) {
    val (tone, text) = when (verdict) {
        is Verdict.Accepted -> Tone.Ok to stringResource(R.string.writeoff_verdict_accepted, verdict.tail)
        is Verdict.Duplicate -> Tone.Warn to stringResource(R.string.writeoff_verdict_duplicate, verdict.tail)
        Verdict.UnknownProduct -> Tone.Err to stringResource(R.string.writeoff_verdict_unknown_product)
        Verdict.UnknownBox -> Tone.Err to stringResource(R.string.writeoff_verdict_unknown_box)
        Verdict.NotACode -> Tone.Err to stringResource(R.string.writeoff_verdict_not_a_code)
    }
    Banner(text, tone, if (tone == Tone.Ok) Icons.Outlined.CheckCircle else Icons.Outlined.Warning)
}

@Composable
private fun LineRow(line: WriteoffLine, onRemove: () -> Unit) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Row(
        Modifier.fillMaxWidth().heightIn(min = 56.dp).clip(RoundedCornerShape(MarkiroSizes.sp2))
            .background(c.surfacePanel).padding(horizontal = MarkiroSizes.sp3),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2),
    ) {
        Icon(
            if (line is WriteoffLine.Box) Icons.Outlined.Inventory2 else Icons.Outlined.RemoveShoppingCart,
            contentDescription = null,
            tint = c.fg3,
            modifier = Modifier.size(20.dp),
        )
        Column(Modifier.weight(1f)) {
            Text(
                line.displayName().ifEmpty { stringResource(R.string.writeoff_unnamed_product) },
                style = t.body,
                color = c.fg1,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(line.secondary(), style = t.caption, color = c.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (line is WriteoffLine.Box) {
            MarkiroChip(pluralStringResource(R.plurals.writeoff_units, line.count, line.count), Tone.Neutral)
        }
        IconAction(Icons.Outlined.Close, stringResource(R.string.writeoff_remove_line), onRemove)
    }
}

@Composable
private fun WriteoffReasonScreen(
    state: WriteoffUi,
    onBack: () -> Unit,
    onSelect: (WriteoffReasonEntity) -> Unit,
    onNext: () -> Unit,
) {
    val c = MarkiroTheme.colors
    Column(Modifier.fillMaxWidth().background(c.surfacePage)) {
        AppBar(stringResource(R.string.writeoff_reason_title), onBack = onBack)
        ScreenColumn(
            padding = PaddingValues(MarkiroSizes.sp4),
            verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2),
        ) {
            // Two per row, as on the kiosk: a gloved thumb needs the width.
            state.reasons.chunked(2).forEach { pair ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2)) {
                    pair.forEach { reason ->
                        ReasonTile(reason, reason.id == state.selectedReason?.id, Modifier.weight(1f)) { onSelect(reason) }
                    }
                    if (pair.size == 1) Spacer(Modifier.weight(1f))
                }
            }
            Spacer(Modifier.height(MarkiroSizes.sp2))
            PrimaryButton(stringResource(R.string.writeoff_reason_confirm), onNext, enabled = state.selectedReason != null)
        }
    }
}

@Composable
private fun ReasonTile(reason: WriteoffReasonEntity, selected: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val c = MarkiroTheme.colors
    val accent = c.tone(Tone.Accent)
    Row(
        modifier.heightIn(min = 72.dp).clip(RoundedCornerShape(MarkiroSizes.sp2))
            .background(if (selected) accent.bg else c.surfacePanel).clickable(onClick = onClick)
            .padding(MarkiroSizes.sp3),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            reason.name,
            style = MarkiroTheme.type.body,
            color = if (selected) accent.fg else c.fg1,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun WriteoffConfirmScreen(state: WriteoffUi, onBack: () -> Unit, onConfirm: () -> Unit) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Column(Modifier.fillMaxWidth().background(c.surfacePage)) {
        AppBar(stringResource(R.string.writeoff_confirm_title), onBack = onBack)
        ScreenColumn(
            padding = PaddingValues(MarkiroSizes.sp4),
            verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3),
        ) {
            SummaryLine(stringResource(R.string.writeoff_summary_reason), state.selectedReason?.name.orEmpty())
            SummaryLine(
                stringResource(R.string.writeoff_summary_units),
                pluralStringResource(R.plurals.writeoff_units, state.unitCount, state.unitCount),
            )
            SummaryLine(
                stringResource(R.string.writeoff_summary_boxes),
                pluralStringResource(R.plurals.writeoff_boxes, state.boxCount, state.boxCount),
            )
            SummaryLine(stringResource(R.string.writeoff_summary_operator), state.operatorName)
            Banner(stringResource(R.string.writeoff_irreversible), Tone.Warn, Icons.Outlined.Warning)
            Spacer(Modifier.height(MarkiroSizes.sp1))
            Text(stringResource(R.string.writeoff_no_price_note), style = t.caption, color = c.fg3)
            DestructiveButton(
                stringResource(
                    R.string.writeoff_do,
                    pluralStringResource(R.plurals.writeoff_units, state.unitCount, state.unitCount),
                ),
                onConfirm,
            )
        }
    }
}

@Composable
private fun SummaryLine(label: String, value: String) {
    val c = MarkiroTheme.colors
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, style = MarkiroTheme.type.caption, color = c.fg3)
        Text(value, style = MarkiroTheme.type.strong, color = c.fg1)
    }
}

/**
 * One screen, three looks: queued while the engine still owes the server,
 * accepted with the act number, and partial when the server refused some lines.
 * Refused lines are named but never returned to a working list — an operator who
 * did not notice would write them off twice.
 */
@Composable
private fun WriteoffResultScreen(state: WriteoffUi, onBack: () -> Unit, onAnother: () -> Unit) {
    val filed = state.filed
    val accepted = filed?.acceptedCount
    val rejected = if (accepted == null) null else (filed.unitCount + filed.boxCount) - accepted
    val (icon, tone, title) = when {
        filed == null || filed.state == "pending" ->
            Triple(Icons.Outlined.Schedule, Tone.Warn, stringResource(R.string.writeoff_result_queued))
        filed.state == "rejected" ->
            Triple(Icons.Outlined.Warning, Tone.Err, stringResource(R.string.writeoff_result_rejected))
        rejected != null && rejected > 0 ->
            Triple(Icons.Outlined.Warning, Tone.Warn, stringResource(R.string.writeoff_result_partial, accepted ?: 0, filed.unitCount + filed.boxCount))
        else -> Triple(Icons.Outlined.CheckCircle, Tone.Ok, stringResource(R.string.writeoff_result_done))
    }
    FullScreenState(
        icon = icon,
        title = title,
        text = when {
            filed == null || filed.state == "pending" -> stringResource(R.string.writeoff_result_queued_text)
            filed.state == "rejected" -> stringResource(R.string.writeoff_result_rejected_text)
            else -> filed.orderNo?.let { stringResource(R.string.writeoff_result_act, it) }.orEmpty()
        },
        primary = StateAction(stringResource(R.string.writeoff_another), onAnother),
        secondary = StateAction(stringResource(R.string.writeoff_to_hub), onBack),
        tone = tone,
    )
}

@Composable
private fun WriteoffLine.displayName(): String = when (this) {
    is WriteoffLine.Unit -> name
    is WriteoffLine.Box -> name
}

@Composable
private fun WriteoffLine.secondary(): String = when (this) {
    is WriteoffLine.Unit -> stringResource(R.string.writeoff_line_code, km.serial.takeLast(8))
    is WriteoffLine.Box -> stringResource(R.string.writeoff_line_box, sscc.takeLast(8))
}

/** History: the last twenty documents this device filed, read-only. */
@Composable
fun WriteoffHistoryScreen(rows: List<WriteoffHistoryRow>, onBack: () -> Unit) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Column(Modifier.fillMaxWidth().background(c.surfacePage)) {
        AppBar(stringResource(R.string.writeoff_history_title), onBack = onBack)
        if (rows.isEmpty()) {
            FullScreenState(
                icon = Icons.Outlined.History,
                title = stringResource(R.string.writeoff_history_empty_title),
                text = stringResource(R.string.writeoff_history_empty_text),
                primary = StateAction(stringResource(R.string.writeoff_to_hub), onBack),
            )
            return@Column
        }
        ScreenColumn(
            padding = PaddingValues(MarkiroSizes.sp4),
            verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2),
        ) {
            rows.forEach { row ->
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 56.dp).clip(RoundedCornerShape(MarkiroSizes.sp2))
                        .background(c.surfacePanel).padding(horizontal = MarkiroSizes.sp3),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2),
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(row.reasonName, style = t.body, color = c.fg1, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            stringResource(
                                R.string.writeoff_counters,
                                pluralStringResource(R.plurals.writeoff_units, row.unitCount, row.unitCount),
                                pluralStringResource(R.plurals.writeoff_boxes, row.boxCount, row.boxCount),
                            ),
                            style = t.caption,
                            color = c.fg3,
                            maxLines = 1,
                        )
                    }
                    when (row.state) {
                        "sent" -> MarkiroChip(
                            row.rejectedCount?.takeIf { it > 0 }
                                ?.let { stringResource(R.string.writeoff_history_partial, it) }
                                ?: row.orderNo.orEmpty().ifEmpty { stringResource(R.string.writeoff_history_sent) },
                            if ((row.rejectedCount ?: 0) > 0) Tone.Warn else Tone.Ok,
                        )
                        "rejected" -> MarkiroChip(stringResource(R.string.writeoff_history_refused), Tone.Err)
                        else -> MarkiroChip(stringResource(R.string.writeoff_history_queued), Tone.Warn)
                    }
                }
            }
        }
    }
}
