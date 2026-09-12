package app.markiro.handheld.feature.work

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.Print
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material.icons.outlined.Wifi
import androidx.compose.material.icons.outlined.WifiOff
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.markiro.handheld.R
import app.markiro.handheld.core.design.Banner
import app.markiro.handheld.core.design.IconAction
import app.markiro.handheld.core.design.MarkiroChip
import app.markiro.handheld.core.design.MarkiroSizes
import app.markiro.handheld.core.design.MarkiroTextButton
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.design.PrimaryButton
import app.markiro.handheld.core.design.StatusItem
import app.markiro.handheld.core.design.StatusStrip
import app.markiro.handheld.core.design.Tone
import app.markiro.handheld.core.design.tone
import app.markiro.handheld.core.km.Verdict
import app.markiro.handheld.core.util.Iso
import app.markiro.handheld.core.util.TimeText
import java.text.NumberFormat

data class WorkCallbacks(
    val onLeave: () -> Unit = {},
    val onClose: () -> Unit = {},
    val onConflicts: () -> Unit = {},
    val onCloseBoxEarly: () -> Unit = {},
    val onLabelQueue: () -> Unit = {},
    val onRequestEarlyPalletClose: () -> Unit = {},
    val onConfirmEarlyPalletClose: () -> Unit = {},
    val onCancelEarlyPalletClose: () -> Unit = {},
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorkScreen(state: WorkUi, cb: WorkCallbacks) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    var menu by remember { mutableStateOf(false) }
    var teamSheet by remember { mutableStateOf(false) }
    val numbers = NumberFormat.getIntegerInstance()
    Column(Modifier.fillMaxSize().background(c.surfacePage)) {
        StatusStrip(
            listOf(
                if (state.reachable) {
                    StatusItem(Icons.Outlined.Wifi, stringResource(R.string.hub_network))
                } else {
                    StatusItem(Icons.Outlined.WifiOff, stringResource(R.string.hub_offline), Tone.Warn)
                },
                StatusItem(Icons.Outlined.Sync, stringResource(R.string.hub_queue, state.sync.pending), if (state.sync.stuck) Tone.Err else Tone.Neutral),
                StatusItem(Icons.Outlined.Print, stringResource(R.string.hub_printer)),
                StatusItem(Icons.Outlined.QrCodeScanner, stringResource(R.string.hub_scanner)),
            ),
        )
        if (state.sync.stuck) {
            Banner(stringResource(R.string.hub_sync_stuck), Tone.Err, Icons.Outlined.Sync)
        } else if (!state.reachable) {
            val text = if (state.sync.pending > 0) {
                stringResource(R.string.hub_offline_banner_queue, pluralStringResource(R.plurals.scans_queued, state.sync.pending, state.sync.pending))
            } else {
                stringResource(R.string.hub_offline_banner)
            }
            Banner(text, Tone.Warn, Icons.Outlined.WifiOff)
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = MarkiroSizes.sp4, vertical = MarkiroSizes.sp2), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(
                    state.shift?.let { it.productPrintName ?: it.productName } ?: "",
                    style = t.strong.copy(fontSize = 16.sp),
                    color = c.fg1,
                    maxLines = 1,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2), verticalAlignment = Alignment.CenterVertically) {
                    Text(state.shift?.number ?: "", style = t.caption, color = c.fg3)
                    state.shift?.counterpartyName?.let { MarkiroChip(stringResource(R.string.shifts_tolling, it), Tone.Info) }
                }
            }
            // Participants are operators with server-side activity; this operator may be absent while their scans are still queued.
            val others = state.team?.participants?.count { it.employeeId != state.operatorId } ?: 0
            if (others > 0) {
                Box(Modifier.clip(RoundedCornerShape(MarkiroSizes.radius)).clickable { teamSheet = true }.padding(MarkiroSizes.sp2)) {
                    MarkiroChip(stringResource(R.string.work_team_chip, others), Tone.Accent)
                }
            }
            Box {
                IconAction(Icons.Outlined.MoreVert, stringResource(R.string.work_more)) { menu = true }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.work_conflicts, state.sync.conflicts)) },
                        onClick = {
                            menu = false
                            cb.onConflicts()
                        },
                    )
                    if (state.box != null) {
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.work_close_box_early, state.box.filled)) },
                            onClick = {
                                menu = false
                                cb.onCloseBoxEarly()
                            },
                        )
                    }
                    if (state.pallet != null) {
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.work_close_pallet_early)) },
                            onClick = {
                                menu = false
                                cb.onRequestEarlyPalletClose()
                            },
                        )
                    }
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.work_leave)) },
                        onClick = {
                            menu = false
                            cb.onLeave()
                        },
                    )
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.work_close)) },
                        onClick = {
                            menu = false
                            cb.onClose()
                        },
                    )
                }
            }
        }
        val box = state.box
        if (box != null) {
            // Aggregation: the fill grid is what the operator reads, so the last
            // scan collapses to one line above it.
            LastScanStrip(state.last)
            BoxHeader(
                stringResource(R.string.work_box_header, box.ordinal, box.filled, box.capacity),
                Modifier.padding(top = MarkiroSizes.sp2),
            )
            // The grid is the main zone in aggregation, so it takes the larger share
            // and the recent-scan feed gives way; the strip above already carries the
            // last verdict.
            BoxFill(box.filled, box.capacity, Modifier.weight(0.62f).padding(MarkiroSizes.sp4))
            state.pallet?.let { PalletStrip(it.boxCount, it.capacity) }
        } else {
            LastScanZone(state.last, state.duplicate, Modifier.weight(0.4f))
        }
        if (state.unprintedLabels > 0) {
            Box(
                Modifier.fillMaxWidth().clickable { cb.onLabelQueue() },
            ) {
                Banner(
                    pluralStringResource(R.plurals.work_labels_unprinted, state.unprintedLabels, state.unprintedLabels),
                    Tone.Warn,
                    Icons.Outlined.Print,
                )
            }
        }
        Row(
            Modifier.fillMaxWidth().padding(horizontal = MarkiroSizes.sp4, vertical = MarkiroSizes.sp2),
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            val total = state.plan?.let { stringResource(R.string.work_plan_of, numbers.format(state.total), numbers.format(it)) }
                ?: numbers.format(state.total)
            Counter(stringResource(R.string.work_total), total)
            Counter(stringResource(R.string.work_this_terminal), numbers.format(state.thisTerminal))
            Counter(
                "",
                stringResource(R.string.work_errors, state.errors, state.duplicates),
                tone = if (state.errors + state.duplicates > 0) Tone.Warn else Tone.Neutral,
            )
        }
        Column(Modifier.weight(if (box != null) 0.38f else 0.6f).fillMaxWidth().padding(horizontal = MarkiroSizes.sp4)) {
            if (state.feed.isEmpty()) Text(stringResource(R.string.work_feed_empty), style = t.caption, color = c.fg3)
            state.feed.forEach { event ->
                val verdict = Verdict.fromWire(event.verdict)
                Row(Modifier.fillMaxWidth().height(32.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Text(Iso.parse(event.scannedAt)?.let { TimeText.hhmm(it) } ?: "", style = t.caption, color = c.fg3)
                    Text("…" + event.raw.takeLast(8), style = t.code.copy(fontSize = 14.sp), color = c.fg1)
                    Text(stringResource(verdict.label()), style = t.caption, color = c.tone(verdict.verdictTone()).fg)
                }
            }
        }
    }
    if (teamSheet) {
        ModalBottomSheet(onDismissRequest = { teamSheet = false }, containerColor = c.surfaceCard) {
            Column(Modifier.padding(MarkiroSizes.sp4), verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2)) {
                Text(stringResource(R.string.work_team_title), style = t.strong, color = c.fg1)
                val participants = state.team?.participants.orEmpty()
                if (participants.isEmpty()) Text(stringResource(R.string.work_team_empty), style = t.caption, color = c.fg3)
                participants.forEach { p ->
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text(p.fullName, style = t.body, color = c.fg1)
                        Text(
                            pluralStringResource(R.plurals.work_team_scans, p.acceptedScans, p.acceptedScans) + " · " +
                                stringResource(R.string.work_team_last, Iso.parse(p.lastActivityAt)?.let { TimeText.hhmm(it) } ?: "—"),
                            style = t.caption,
                            color = c.fg3,
                        )
                    }
                }
                state.team?.let { Text(stringResource(R.string.common_data_as_of, TimeText.hhmm(it.at)), style = t.caption, color = c.fg3) }
            }
        }
    }
    // «Закрыть паллету досрочно» names the box count before doing anything
    // (design brief 10 §6), rather than closing on the first tap the way the
    // box's own overflow entry does.
    val palletConfirm = state.palletConfirm
    if (palletConfirm != null) {
        ModalBottomSheet(onDismissRequest = cb.onCancelEarlyPalletClose, containerColor = c.surfaceCard) {
            Column(Modifier.padding(MarkiroSizes.sp4), verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2)) {
                Text(stringResource(R.string.pallet_close_confirm_title), style = t.strong, color = c.fg1)
                Text(
                    stringResource(R.string.pallet_close_confirm_body, palletConfirm.boxCount, palletConfirm.capacity),
                    style = t.body,
                    color = c.fg2,
                )
                PrimaryButton(stringResource(R.string.pallet_close_confirm_confirm), cb.onConfirmEarlyPalletClose)
                MarkiroTextButton(stringResource(R.string.common_cancel), cb.onCancelEarlyPalletClose)
            }
        }
    }
}

fun Verdict.label(): Int = when (this) {
    Verdict.OK -> R.string.signal_ok
    Verdict.DUPLICATE -> R.string.signal_duplicate
    Verdict.WRONG_GTIN -> R.string.signal_wrong_gtin
    Verdict.INVALID -> R.string.signal_wrong_code
}

fun Verdict.verdictTone(): Tone = when (this) {
    Verdict.OK -> Tone.Ok
    Verdict.DUPLICATE -> Tone.Warn
    Verdict.WRONG_GTIN, Verdict.INVALID -> Tone.Err
}

@Composable
private fun LastScanZone(last: LastScan?, duplicate: DuplicateUi?, modifier: Modifier) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    // A refusal is its own tone. Taking it from the verdict painted the zone
    // GREEN, because a refused scan carries `Verdict.OK` -- it was never judged.
    val colors = last?.let { c.tone(if (it.blocked) Tone.Warn else it.verdict.verdictTone()) }
    Column(
        modifier.fillMaxWidth().padding(horizontal = MarkiroSizes.sp4).clip(RoundedCornerShape(MarkiroSizes.radius))
            .background(colors?.bg ?: c.surfaceCard).padding(MarkiroSizes.sp4),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        if (last == null || colors == null) {
            Icon(Icons.Outlined.QrCodeScanner, contentDescription = null, tint = c.fg3)
            Text(stringResource(R.string.work_waiting), style = t.strong, color = c.fg3)
        } else if (last.blocked) {
            Icon(Icons.Outlined.Print, contentDescription = null, tint = colors.fg)
            Text(stringResource(R.string.duplicate_blocked), style = t.title, color = colors.fg, textAlign = TextAlign.Center)
        } else {
            val icon = when (last.verdict) {
                Verdict.OK -> Icons.Outlined.CheckCircle
                Verdict.DUPLICATE -> Icons.Outlined.ContentCopy
                else -> Icons.Outlined.ErrorOutline
            }
            Icon(icon, contentDescription = null, tint = colors.fg)
            Text(stringResource(last.verdict.label()), style = t.title, color = colors.fg)
            Text(last.tail, style = t.code, color = c.fg1)
            last.firstSeenAt?.let { seen ->
                Text(stringResource(R.string.work_first_seen, Iso.parse(seen)?.let { TimeText.hhmm(it) } ?: seen), style = t.caption, color = c.fg2)
            }
        }
        // The duplicate's progress lives here rather than over the screen: it
        // prints on EVERY unit, so a full-screen state per scan would be
        // unusable. «Отсканируйте наклейку» is the line an operator cannot
        // guess -- without it they scan the next product, are told it is the
        // wrong code, and have no idea why.
        if (duplicate != null) {
            val line = when {
                duplicate.awaitingVerification -> R.string.duplicate_awaiting_verification
                duplicate.printing -> R.string.duplicate_printing
                else -> null
            }
            if (line != null) {
                Text(
                    stringResource(line),
                    style = t.strong,
                    color = if (duplicate.awaitingVerification) c.tone(Tone.Warn).fg else c.fg2,
                    modifier = Modifier.padding(top = MarkiroSizes.sp2),
                )
            }
        }
    }
}

/**
 * The last scan, one line high.
 *
 * In aggregation the grid is what the operator reads, so the verdict keeps its
 * colour and its word but gives up the main zone. The word is always there:
 * colour alone must never be the only carrier of a verdict.
 */
@Composable
private fun LastScanStrip(last: LastScan?) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    val colors = last?.verdict?.verdictTone()?.let { c.tone(it) }
    Row(
        Modifier.fillMaxWidth().padding(horizontal = MarkiroSizes.sp4).clip(RoundedCornerShape(MarkiroSizes.radius))
            .background(colors?.bg ?: c.surfaceCard).padding(horizontal = MarkiroSizes.sp3, vertical = MarkiroSizes.sp2),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (last == null || colors == null) {
            Text(stringResource(R.string.work_waiting), style = t.caption, color = c.fg3)
        } else {
            Text(stringResource(last.verdict.label()), style = t.strong.copy(fontSize = 16.sp), color = colors.fg)
            Text(last.tail, style = t.code.copy(fontSize = 16.sp), color = c.fg1)
        }
    }
}

@Composable
private fun Counter(label: String, value: String, tone: Tone = Tone.Neutral) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Column(horizontalAlignment = Alignment.Start) {
        if (label.isNotEmpty()) Text(label, style = t.caption, color = c.fg3)
        Text(value, style = t.strong.copy(fontSize = 16.sp), color = if (tone == Tone.Neutral) c.fg1 else c.tone(tone).fg)
    }
}
