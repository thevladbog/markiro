package app.markiro.handheld.feature.hub

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.outlined.Factory
import androidx.compose.material.icons.outlined.Inventory2
import androidx.compose.material.icons.outlined.Print
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material.icons.outlined.Wifi
import androidx.compose.material.icons.outlined.WifiOff
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.markiro.handheld.R
import app.markiro.handheld.core.design.Banner
import app.markiro.handheld.core.design.IconAction
import app.markiro.handheld.core.design.MarkiroSizes
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.design.StatusItem
import app.markiro.handheld.core.design.StatusStrip
import app.markiro.handheld.core.design.Tile
import app.markiro.handheld.core.design.Tone
import app.markiro.handheld.core.util.TimeText

@Composable
fun HubScreen(state: HubUi, onTile: (HubTile) -> Unit, onSignOut: () -> Unit) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Column(Modifier.fillMaxSize().background(c.surfacePage)) {
        StatusStrip(
            listOf(
                if (state.reachable) {
                    StatusItem(Icons.Outlined.Wifi, stringResource(R.string.hub_network))
                } else {
                    StatusItem(Icons.Outlined.WifiOff, stringResource(R.string.hub_offline), Tone.Warn)
                },
                StatusItem(Icons.Outlined.Sync, stringResource(R.string.hub_queue, state.queue), if (state.stuck) Tone.Err else Tone.Neutral),
                StatusItem(Icons.Outlined.Print, stringResource(R.string.hub_printer)),
                StatusItem(Icons.Outlined.QrCodeScanner, state.scannerLabel.ifEmpty { stringResource(R.string.hub_scanner) }),
            ),
        )
        if (state.stuck) {
            Banner(stringResource(R.string.hub_sync_stuck), Tone.Err, Icons.Outlined.Sync)
        } else if (!state.reachable) {
            val text = if (state.queue > 0) {
                stringResource(R.string.hub_offline_banner_queue, pluralStringResource(R.plurals.scans_queued, state.queue, state.queue))
            } else {
                stringResource(R.string.hub_offline_banner)
            }
            Banner(text, Tone.Warn, Icons.Outlined.WifiOff)
        }
        // Labels owed on boxes already closed and reported. Shown on the hub
        // because the queue belongs to the device, not to any one shift.
        if (state.unprintedLabels > 0) {
            Banner(
                pluralStringResource(R.plurals.work_labels_unprinted, state.unprintedLabels, state.unprintedLabels),
                Tone.Warn,
                Icons.Outlined.Print,
            )
        }
        Column(Modifier.padding(MarkiroSizes.sp4), verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3)) {
            Row(Modifier.fillMaxWidth().height(44.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(state.organization, style = t.caption, color = c.fg3)
                    Text(
                        listOfNotNull(state.operatorName.ifEmpty { null }, state.lineName).joinToString(" · "),
                        style = t.strong.copy(fontSize = 16.sp),
                        color = c.fg1,
                    )
                }
                IconAction(Icons.AutoMirrored.Outlined.Logout, stringResource(R.string.hub_sign_out), onSignOut)
            }
            val stamp = state.countsAt?.takeIf { !state.reachable }
                ?.let { " · " + stringResource(R.string.common_data_as_of, TimeText.hhmm(it)) }
                .orEmpty()
            // Intrinsic height keeps both tiles of a row equal when one status wraps to two lines.
            val tile = Modifier.weight(1f).fillMaxHeight()
            Row(Modifier.fillMaxWidth().height(IntrinsicSize.Max), horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3)) {
                Tile(
                    Icons.Outlined.Factory,
                    stringResource(R.string.hub_tile_shift),
                    state.continueShiftNumber?.let { stringResource(R.string.hub_shift_continue, it) } ?: (shiftsLabel(state.shifts) + stamp),
                    { onTile(HubTile.SHIFT) },
                    tile,
                    statusTone = if (state.continueShiftNumber != null) Tone.Ok else Tone.Neutral,
                )
                Tile(
                    Icons.Outlined.Inventory2,
                    stringResource(R.string.hub_tile_inventory),
                    state.continueInventoryNumber?.let { stringResource(R.string.hub_inventory_continue, it) } ?: (inventoriesLabel(state.inventories) + stamp),
                    { onTile(HubTile.INVENTORY) },
                    tile,
                    statusTone = if (state.continueInventoryNumber != null) Tone.Ok else Tone.Neutral,
                )
            }
            Row(Modifier.fillMaxWidth().height(IntrinsicSize.Max), horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3)) {
                Tile(Icons.Outlined.QrCodeScanner, stringResource(R.string.hub_tile_check), stringResource(R.string.hub_check_status), { onTile(HubTile.CHECK) }, tile)
                Tile(
                    Icons.Outlined.Settings,
                    stringResource(R.string.hub_tile_settings),
                    if (state.printerConfigured) "" else stringResource(R.string.hub_printer_not_set),
                    { onTile(HubTile.SETTINGS) },
                    tile,
                    statusTone = if (state.printerConfigured) Tone.Neutral else Tone.Warn,
                )
            }
        }
    }
}

@Composable
internal fun shiftsLabel(count: Int?): String = when (count) {
    null -> stringResource(R.string.common_no_data)
    0 -> stringResource(R.string.hub_no_shifts)
    else -> pluralStringResource(R.plurals.hub_shifts_available, count, count)
}

@Composable
internal fun inventoriesLabel(count: Int?): String = when (count) {
    null -> stringResource(R.string.common_no_data)
    0 -> stringResource(R.string.hub_no_tasks)
    else -> pluralStringResource(R.plurals.hub_inventory_tasks, count, count)
}
