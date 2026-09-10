package app.markiro.handheld.feature.inventory

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
import androidx.compose.material.icons.outlined.Inventory2
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material.icons.outlined.Wifi
import androidx.compose.material.icons.outlined.WifiOff
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SelectableDates
import androidx.compose.material3.Text
import androidx.compose.material3.rememberDatePickerState
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
import app.markiro.handheld.core.design.FullScreenState
import app.markiro.handheld.core.design.IconAction
import app.markiro.handheld.core.design.MarkiroChip
import app.markiro.handheld.core.design.MarkiroSizes
import app.markiro.handheld.core.design.MarkiroTextButton
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.design.PrimaryButton
import app.markiro.handheld.core.design.SecondaryButton
import app.markiro.handheld.core.design.StateAction
import app.markiro.handheld.core.design.StatusItem
import app.markiro.handheld.core.design.StatusStrip
import app.markiro.handheld.core.design.Tone
import app.markiro.handheld.core.design.tone
import app.markiro.handheld.core.inventory.InventoryTail
import app.markiro.handheld.core.inventory.InventoryVerdict
import app.markiro.handheld.core.util.Iso
import app.markiro.handheld.core.util.TimeText
import java.text.NumberFormat
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

data class InventoryWorkCallbacks(
    val onLeave: () -> Unit = {},
    val onToHub: () -> Unit = {},
    val onApplyDate: () -> Unit = {},
    val onAcceptAsIs: () -> Unit = {},
    val onSkip: () -> Unit = {},
    val onSetDate: (String) -> Unit = {},
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InventoryWorkScreen(state: InventoryWorkUi, cb: InventoryWorkCallbacks) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    var menu by remember { mutableStateOf(false) }
    var dateSheet by remember { mutableStateOf(false) }
    val numbers = NumberFormat.getIntegerInstance()
    if (state.closed) {
        Column(Modifier.fillMaxSize().background(c.surfacePage)) {
            FullScreenState(
                Icons.Outlined.Inventory2,
                stringResource(R.string.inventory_closed_title),
                stringResource(R.string.inventory_closed_text),
                primary = StateAction(stringResource(R.string.inventory_to_hub), cb.onToHub),
                tone = Tone.Warn,
            )
        }
        return
    }
    Column(Modifier.fillMaxSize().background(c.surfacePage)) {
        StatusStrip(
            listOf(
                if (state.reachable) {
                    StatusItem(Icons.Outlined.Wifi, stringResource(R.string.hub_network))
                } else {
                    StatusItem(Icons.Outlined.WifiOff, stringResource(R.string.hub_offline), Tone.Warn)
                },
                StatusItem(Icons.Outlined.Sync, stringResource(R.string.hub_queue, state.sync.pending), if (state.sync.stuck) Tone.Err else Tone.Neutral),
                StatusItem(Icons.Outlined.QrCodeScanner, stringResource(R.string.hub_scanner)),
            ),
        )
        if (state.sync.stuck) {
            Banner(stringResource(R.string.hub_sync_stuck), Tone.Err, Icons.Outlined.Sync)
        } else if (!state.reachable) {
            val text = if (state.sync.pending > 0) {
                stringResource(R.string.hub_offline_banner_queue, pluralStringResource(R.plurals.inventory_events_queued, state.sync.pending, state.sync.pending))
            } else {
                stringResource(R.string.hub_offline_banner)
            }
            Banner(text, Tone.Warn, Icons.Outlined.WifiOff)
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = MarkiroSizes.sp4, vertical = MarkiroSizes.sp2), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(state.task?.let { it.productPrintName ?: it.productName } ?: "", style = t.strong.copy(fontSize = 16.sp), color = c.fg1, maxLines = 1)
                Text(state.task?.inventoryNumber ?: "", style = t.caption, color = c.fg3)
            }
            state.activeDate?.let { date ->
                Box(Modifier.clip(RoundedCornerShape(MarkiroSizes.radius)).clickable { dateSheet = true }.padding(MarkiroSizes.sp2)) {
                    MarkiroChip(stringResource(R.string.inventory_active_date, civilDate(date)), Tone.Info)
                }
            }
            Box {
                IconAction(Icons.Outlined.MoreVert, stringResource(R.string.work_more)) { menu = true }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.inventory_change_date)) },
                        onClick = {
                            menu = false
                            dateSheet = true
                        },
                    )
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.inventory_leave)) },
                        onClick = {
                            menu = false
                            cb.onLeave()
                        },
                    )
                }
            }
        }
        LastZone(state.last, Modifier.weight(0.4f))
        Row(
            Modifier.fillMaxWidth().padding(horizontal = MarkiroSizes.sp4, vertical = MarkiroSizes.sp2),
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Counter(
                stringResource(R.string.inventory_verified),
                stringResource(R.string.inventory_of, numbers.format(state.progress.verified), numbers.format(state.expectedCount)),
            )
            Counter(stringResource(R.string.inventory_this_terminal), numbers.format(state.progress.thisTerminal))
            Counter(
                stringResource(R.string.inventory_discrepancies),
                numbers.format(state.progress.discrepancies),
                if (state.progress.discrepancies > 0) Tone.Warn else Tone.Neutral,
            )
        }
        if (state.progress.protected > 0 || state.progress.rejected > 0) {
            Text(
                listOfNotNull(
                    state.progress.protected.takeIf { it > 0 }?.let { stringResource(R.string.inventory_protected_count, it) },
                    state.progress.rejected.takeIf { it > 0 }?.let { stringResource(R.string.inventory_rejected_count, it) },
                ).joinToString(" · "),
                style = t.caption,
                color = c.fg3,
                modifier = Modifier.padding(horizontal = MarkiroSizes.sp4),
            )
        }
        Column(Modifier.weight(0.6f).fillMaxWidth().padding(horizontal = MarkiroSizes.sp4)) {
            if (state.feed.isEmpty()) Text(stringResource(R.string.inventory_feed_empty), style = t.caption, color = c.fg3)
            state.feed.forEach { event ->
                val verdict = InventoryVerdict.fromWire(event.localVerdict)
                Row(Modifier.fillMaxWidth().height(32.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Text(Iso.parse(event.scannedAt)?.let { TimeText.hhmm(it) } ?: "", style = t.caption, color = c.fg3)
                    Text(InventoryTail.ofEvent(event.kind, event.canonicalRaw) ?: "…", style = t.code.copy(fontSize = 14.sp), color = c.fg1)
                    Text(stringResource(verdict.label()), style = t.caption, color = c.tone(verdict.tone()).fg)
                }
            }
        }
    }
    state.held?.let { held ->
        ModalBottomSheet(onDismissRequest = cb.onSkip, containerColor = c.surfaceCard) {
            Column(Modifier.padding(MarkiroSizes.sp4), verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3)) {
                Text(stringResource(if (held.mixed) R.string.inventory_mixed_title else R.string.inventory_mismatch_title), style = t.strong, color = c.fg1)
                if (held.mixed) {
                    Text(stringResource(R.string.inventory_mixed_text), style = t.body, color = c.fg2)
                } else {
                    Text(stringResource(R.string.inventory_mismatch_code, civilDate(held.codeDate.orEmpty())), style = t.body, color = c.fg1)
                    Text(stringResource(R.string.inventory_mismatch_active, civilDate(held.activeDate)), style = t.body, color = c.fg2)
                    PrimaryButton(stringResource(R.string.inventory_mismatch_apply, civilDate(held.codeDate.orEmpty())), cb.onApplyDate)
                }
                SecondaryButton(stringResource(R.string.inventory_mismatch_accept), cb.onAcceptAsIs)
                MarkiroTextButton(stringResource(R.string.inventory_mismatch_skip), cb.onSkip)
            }
        }
    }
    val task = state.task
    if (dateSheet && task != null) {
        val from = LocalDate.parse(task.productionDateFrom).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()
        val to = LocalDate.parse(task.productionDateTo).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()
        val picker = rememberDatePickerState(
            initialSelectedDateMillis = state.activeDate?.let { LocalDate.parse(it).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli() },
            selectableDates = object : SelectableDates {
                override fun isSelectableDate(utcTimeMillis: Long) = utcTimeMillis in from..to
            },
        )
        ModalBottomSheet(onDismissRequest = { dateSheet = false }, containerColor = c.surfaceCard) {
            Column(Modifier.padding(MarkiroSizes.sp4), verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3)) {
                Text(stringResource(R.string.inventory_date_title), style = t.strong, color = c.fg1)
                DatePicker(state = picker, showModeToggle = false, title = null, headline = null)
                PrimaryButton(
                    stringResource(R.string.inventory_date_apply),
                    {
                        picker.selectedDateMillis?.let { cb.onSetDate(Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate().toString()) }
                        dateSheet = false
                    },
                    enabled = picker.selectedDateMillis != null,
                )
                MarkiroTextButton(stringResource(R.string.common_cancel), onClick = { dateSheet = false })
            }
        }
    }
}

@Composable
private fun LastZone(last: InventoryLastScan?, modifier: Modifier) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    val colors = last?.verdict?.tone()?.let { c.tone(it) }
    Column(
        modifier.fillMaxWidth().padding(horizontal = MarkiroSizes.sp4).clip(RoundedCornerShape(MarkiroSizes.radius))
            .background(colors?.bg ?: c.surfaceCard).padding(MarkiroSizes.sp4),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        if (last == null || colors == null) {
            Icon(Icons.Outlined.QrCodeScanner, contentDescription = null, tint = c.fg3)
            Text(stringResource(R.string.inventory_waiting), style = t.strong, color = c.fg3)
            return
        }
        val icon = when (last.verdict) {
            InventoryVerdict.EXPECTED -> Icons.Outlined.CheckCircle
            InventoryVerdict.DUPLICATE -> Icons.Outlined.ContentCopy
            else -> Icons.Outlined.ErrorOutline
        }
        Icon(icon, contentDescription = null, tint = colors.fg)
        val title = if (last.verdict == InventoryVerdict.EXPECTED && last.boxTotal != null) R.string.inventory_verdict_box else last.verdict.label()
        Text(stringResource(title), style = t.title, color = colors.fg)
        last.tail?.let { Text(it, style = t.code, color = c.fg1) }
        val detail = when (last.verdict) {
            InventoryVerdict.EXPECTED -> last.boxTotal?.let { stringResource(R.string.inventory_box_counted, last.boxCounted ?: 0, it) }
            InventoryVerdict.DUPLICATE -> last.winner?.let { w ->
                val at = Iso.parse(w.scannedAt)?.let { TimeText.hhmm(it) } ?: "—"
                stringResource(if (last.ownDevice) R.string.inventory_duplicate_here else R.string.inventory_duplicate_other, at)
            }
            InventoryVerdict.PROTECTED -> stringResource(R.string.inventory_protected_text)
            InventoryVerdict.KNOWN_INELIGIBLE -> last.sourceStatus?.let { stringResource(R.string.inventory_ineligible_text, stringResource(statusLabel(it))) }
            InventoryVerdict.UNKNOWN -> stringResource(R.string.inventory_unknown_text)
            InventoryVerdict.INVALID -> when (last.invalidReason) {
                "wrong_gtin" -> stringResource(R.string.inventory_invalid_wrong_gtin)
                "unsupported" -> stringResource(R.string.inventory_invalid_unsupported)
                else -> null
            }
        }
        detail?.let { Text(it, style = t.caption, color = c.fg2) }
    }
}

@Composable
private fun Counter(label: String, value: String, tone: Tone = Tone.Neutral) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Column(horizontalAlignment = Alignment.Start) {
        Text(label, style = t.caption, color = c.fg3)
        Text(value, style = t.strong.copy(fontSize = 16.sp), color = if (tone == Tone.Neutral) c.fg1 else c.tone(tone).fg)
    }
}
