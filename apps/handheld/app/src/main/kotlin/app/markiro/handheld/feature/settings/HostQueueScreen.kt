package app.markiro.handheld.feature.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.sp
import app.markiro.handheld.R
import app.markiro.handheld.core.design.AppBar
import app.markiro.handheld.core.design.MarkiroChip
import app.markiro.handheld.core.design.MarkiroSizes
import app.markiro.handheld.core.design.MarkiroTextButton
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.design.PrimaryButton
import app.markiro.handheld.core.design.Tone
import app.markiro.handheld.core.design.tone
import app.markiro.handheld.core.network.host.RejectionHint
import app.markiro.handheld.core.util.Iso
import app.markiro.handheld.core.util.TimeText

data class HostQueueCallbacks(
    val onBack: () -> Unit = {},
    val onSendNow: () -> Unit = {},
    val onSupport: (String) -> Unit = {},
)

/**
 * What the host is still owed and what it refused. A refused record never stops the line; it stays here, with the reason in the operator's
 * words and the host's own code beside it, until support has seen it.
 */
@Composable
fun HostQueueScreen(state: HostQueueUi, cb: HostQueueCallbacks) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Column(Modifier.fillMaxSize().background(c.surfacePage)) {
        AppBar(stringResource(R.string.host_queue_title), onBack = cb.onBack)
        if (state.items.isEmpty()) {
            Text(stringResource(R.string.host_queue_empty), style = t.body, color = c.fg3, modifier = Modifier.padding(MarkiroSizes.sp4))
            return@Column
        }
        LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2)) {
            items(state.items, key = { it.recordId }) { item ->
                Column(Modifier.fillMaxWidth().padding(horizontal = MarkiroSizes.sp4, vertical = MarkiroSizes.sp2)) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                        Row(horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2), verticalAlignment = Alignment.CenterVertically) {
                            MarkiroChip(stringResource(if (item.quarantined) R.string.host_queue_refused else R.string.host_queue_waiting))
                            Text(hostKindText(item.kind), style = t.body, color = c.fg1)
                        }
                        Text(Iso.parse(item.createdAt)?.let { TimeText.hhmm(it) }.orEmpty(), style = t.caption, color = c.fg3)
                    }
                    item.subject?.let { Text("…$it", style = t.code.copy(fontSize = 16.sp), color = c.fg2) }
                    if (item.quarantined) {
                        Text(hintText(item.hint), style = t.caption, color = c.tone(Tone.Warn).fg)
                        item.code?.let { Text(it, style = t.caption, color = c.fg3) }
                        MarkiroTextButton(stringResource(R.string.host_queue_support), { cb.onSupport(item.recordId) })
                    }
                }
            }
        }
        Column(Modifier.padding(MarkiroSizes.sp4)) {
            PrimaryButton(stringResource(R.string.host_queue_send_now), cb.onSendNow)
        }
    }
}

@Composable
internal fun hostKindText(kind: String): String = when (kind) {
    "scan" -> stringResource(R.string.host_queue_kind_scan)
    "box_closed" -> stringResource(R.string.host_queue_kind_box)
    "pallet_closed" -> stringResource(R.string.host_queue_kind_pallet)
    "shift_closed" -> stringResource(R.string.host_queue_kind_shift_close)
    "warehouse_pallet_opened" -> stringResource(R.string.host_queue_kind_wh_open)
    "pallet_box_added" -> stringResource(R.string.host_queue_kind_wh_add)
    "pallet_box_removed" -> stringResource(R.string.host_queue_kind_wh_remove)
    "warehouse_pallet_closed" -> stringResource(R.string.host_queue_kind_wh_close)
    else -> kind
}

@Composable
internal fun hintText(hint: RejectionHint?): String = when (hint) {
    RejectionHint.OTHER_DEVICE_OR_CLOSED -> stringResource(R.string.host_reject_other_device)
    RejectionHint.BUG -> stringResource(R.string.host_reject_bug)
    RejectionHint.LICENSE -> stringResource(R.string.host_reject_license)
    RejectionHint.PALLET_CONFLICT -> stringResource(R.string.host_reject_pallet_conflict)
    RejectionHint.DATA, null -> stringResource(R.string.host_reject_data)
}
