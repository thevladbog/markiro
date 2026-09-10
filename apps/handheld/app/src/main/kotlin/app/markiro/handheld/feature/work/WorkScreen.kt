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
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.markiro.handheld.R
import app.markiro.handheld.core.design.Banner
import app.markiro.handheld.core.design.IconAction
import app.markiro.handheld.core.design.MarkiroChip
import app.markiro.handheld.core.design.MarkiroSizes
import app.markiro.handheld.core.design.MarkiroTheme
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
            val others = (state.team?.participants?.size ?: 1) - 1
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
        LastScanZone(state.last, Modifier.weight(0.4f))
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
        Column(Modifier.weight(0.6f).fillMaxWidth().padding(horizontal = MarkiroSizes.sp4)) {
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
private fun LastScanZone(last: LastScan?, modifier: Modifier) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    val colors = last?.verdict?.verdictTone()?.let { c.tone(it) }
    Column(
        modifier.fillMaxWidth().padding(horizontal = MarkiroSizes.sp4).clip(RoundedCornerShape(MarkiroSizes.radius))
            .background(colors?.bg ?: c.surfaceCard).padding(MarkiroSizes.sp4),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        if (last == null || colors == null) {
            Icon(Icons.Outlined.QrCodeScanner, contentDescription = null, tint = c.fg3)
            Text(stringResource(R.string.work_waiting), style = t.strong, color = c.fg3)
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
