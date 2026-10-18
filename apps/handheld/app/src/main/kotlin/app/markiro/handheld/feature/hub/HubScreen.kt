package app.markiro.handheld.feature.hub

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.outlined.Factory
import androidx.compose.material.icons.outlined.Inventory2
import androidx.compose.material.icons.outlined.Layers
import androidx.compose.material.icons.outlined.Print
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material.icons.outlined.RemoveShoppingCart
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material.icons.outlined.Wifi
import androidx.compose.material.icons.outlined.WifiOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.serialization.json.*
import app.markiro.handheld.R
import app.markiro.handheld.core.host.HostLinkStatus
import app.markiro.handheld.core.design.Banner
import app.markiro.handheld.core.design.IconAction
import app.markiro.handheld.core.design.MarkiroSizes
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.design.ScreenColumn
import app.markiro.handheld.core.design.StatusItem
import app.markiro.handheld.core.design.StatusStrip
import app.markiro.handheld.core.design.Tile
import app.markiro.handheld.core.design.Tone
import app.markiro.handheld.core.util.TimeText

@Composable
fun HubScreen(
    state: HubUi,
    onTile: (HubTile) -> Unit,
    onSignOut: () -> Unit,
    onLabelQueue: () -> Unit = {},
    onHostQueue: () -> Unit = {},
    onContinueShift: (String) -> Unit = { onTile(HubTile.SHIFT) },
    onDismissDialog: () -> Unit = {},
    /** The host's certificate changed: pair this device again (seals the credential; the pairing asks for the new fingerprint). */
    onRepairHost: () -> Unit = {},
) {
    var confirmRepair by remember { mutableStateOf(false) }
    if (confirmRepair) {
        AlertDialog(
            onDismissRequest = { confirmRepair = false },
            title = { Text(stringResource(R.string.host_link_repair_title), color = MarkiroTheme.colors.fg1) },
            text = { Text(stringResource(R.string.host_link_repair_text), color = MarkiroTheme.colors.fg2) },
            confirmButton = { TextButton(onClick = { confirmRepair = false; onRepairHost() }) { Text(stringResource(R.string.host_link_repair)) } },
            dismissButton = { TextButton(onClick = { confirmRepair = false }) { Text(stringResource(R.string.common_cancel)) } },
            containerColor = MarkiroTheme.colors.surfacePanel,
        )
    }
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    // «Продолжить» goes through the list's own entry and can be refused the
    // same way; while it is, the entry's state takes the screen as it does there.
    state.dialog?.let { dialog ->
        Column(Modifier.fillMaxSize().background(c.surfacePage)) {
            app.markiro.handheld.feature.shift.ShiftDialogScreen(
                dialog, state.lineName, onDismiss = onDismissDialog,
                onRetry = { state.activeShiftId?.let(onContinueShift) ?: onDismissDialog() },
            )
        }
        return
    }
    Column(Modifier.fillMaxSize().background(c.surfacePage)) {
        StatusStrip(
            listOf(
                if (state.hostMode && state.hostLink != null) {
                    // Text and icon both say it: a state is never told by colour alone.
                    when (state.hostLink) {
                        HostLinkStatus.Online -> StatusItem(Icons.Outlined.Wifi, stringResource(R.string.host_link_online))
                        HostLinkStatus.Offline -> StatusItem(Icons.Outlined.WifiOff, stringResource(R.string.host_link_offline), Tone.Warn)
                        HostLinkStatus.Restoring -> StatusItem(Icons.Outlined.Sync, stringResource(R.string.host_link_restoring), Tone.Warn)
                        HostLinkStatus.ClockSkew -> StatusItem(Icons.Outlined.Schedule, stringResource(R.string.host_link_clock_skew), Tone.Warn)
                        HostLinkStatus.CertificateChanged -> StatusItem(Icons.Outlined.WifiOff, stringResource(R.string.host_link_certificate), Tone.Err)
                    }
                } else if (state.reachable) {
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
        } else if (state.hostMode && state.hostLink != null) {
            // The work goes on in every state of the link; the banner says why the queue is not going out.
            when (state.hostLink) {
                HostLinkStatus.Online -> Unit
                HostLinkStatus.Offline -> Banner(stringResource(R.string.host_link_offline_banner), Tone.Warn, Icons.Outlined.WifiOff)
                HostLinkStatus.Restoring -> Banner(stringResource(R.string.host_link_restoring_banner), Tone.Warn, Icons.Outlined.Sync)
                HostLinkStatus.ClockSkew -> Banner(stringResource(R.string.host_link_clock_skew_banner), Tone.Warn, Icons.Outlined.Schedule)
                // The one state with no way out by waiting: the banner is the way into pairing again.
                HostLinkStatus.CertificateChanged -> Box(Modifier.fillMaxWidth().clickable(onClick = { confirmRepair = true })) {
                    Banner(stringResource(R.string.host_link_certificate_banner), Tone.Err, Icons.Outlined.WifiOff)
                }
            }
        } else if (!state.reachable) {
            val text = if (state.queue > 0) {
                stringResource(R.string.hub_offline_banner_queue, pluralStringResource(R.plurals.scans_queued, state.queue, state.queue))
            } else {
                stringResource(R.string.hub_offline_banner)
            }
            Banner(text, Tone.Warn, Icons.Outlined.WifiOff)
        }
        // What the host refused stays for support and is one tap from here; a refused record never stops the line.
        if (state.hostMode && (state.queue > 0 || state.hostQuarantined > 0)) {
            Box(Modifier.fillMaxWidth().clickable(onClick = onHostQueue)) {
                Banner(
                    stringResource(R.string.host_queue_banner, state.queue, state.hostQuarantined),
                    if (state.hostQuarantined > 0) Tone.Warn else Tone.Neutral,
                    Icons.Outlined.Sync,
                )
            }
        }
        // Labels owed on boxes already closed and reported. Shown on the hub
        // because the queue belongs to the device, not to any one shift.
        if (state.unprintedLabels > 0) {
            Box(Modifier.fillMaxWidth().clickable(onClick = onLabelQueue)) {
                Banner(
                    pluralStringResource(R.plurals.work_labels_unprinted, state.unprintedLabels, state.unprintedLabels),
                    Tone.Warn,
                    Icons.Outlined.Print,
                )
            }
        }
        BoxWithConstraints(Modifier.weight(1f)) {
            val columns = if (maxWidth / LocalDensity.current.fontScale >= 400.dp) 2 else 1
            ScreenColumn(padding = PaddingValues(MarkiroSizes.sp4), verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3)) {
                Row(Modifier.fillMaxWidth().heightIn(min = 44.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(state.organization, style = t.caption, color = c.fg3)
                        Text(
                            listOfNotNull(state.operatorName.ifEmpty { null }, state.lineName).joinToString(" · "),
                            style = t.strong.copy(fontSize = 16.sp),
                            color = c.fg1,
                        )
                    }
                    IconAction(Icons.AutoMirrored.Outlined.Logout, stringResource(R.string.hub_sign_out), onClick = onSignOut)
                }
                if (state.replacementBlocked) {
                    Banner(stringResource(if (state.replacementTargetWaiting) R.string.replacement_waiting else if (state.replacementClosed) R.string.replacement_closed else R.string.replacement_drain), Tone.Warn, Icons.Outlined.Sync)
                    state.replacementCounters?.let { counts ->
                        val pending = counts.getValue("pending").jsonObject
                        for ((key,label) in listOf("scans" to R.string.replacement_scans, "inventories" to R.string.replacement_inventories,
                            "shiftClosures" to R.string.replacement_closures, "productLabels" to R.string.replacement_labels,
                            "boxes" to R.string.replacement_boxes, "exceptions" to R.string.replacement_exceptions,
                            "conflicts" to R.string.replacement_conflicts, "unknownPrints" to R.string.replacement_prints)) {
                            val value = (pending[key] ?: counts.getValue(key)).jsonPrimitive.content
                            Text(stringResource(label, if (value == "unsupported") stringResource(R.string.common_no_data) else value), style=t.caption, color=c.fg2)
                        }
                        Text(stringResource(R.string.replacement_tasks, counts.getValue("activeTasks").jsonArray.size), style=t.caption, color=c.fg2)
                    }
                }
                state.activeShift?.let { active ->
                    ActiveShiftCard(active, onContinue = { onContinueShift(active.shift.id) })
                }
                val stamp = state.countsAt?.takeIf { !state.reachable }
                    ?.let { " · " + stringResource(R.string.common_data_as_of, TimeText.hhmm(it)) }
                    .orEmpty()
                val byTile: Map<HubTile, @Composable (Modifier) -> Unit> = mapOf(
                    HubTile.SHIFT to { modifier ->
                        Tile(
                            Icons.Outlined.Factory,
                            stringResource(R.string.hub_tile_shift),
                            shiftsLabel(state.shifts) + stamp,
                            { if (!state.replacementBlocked) onTile(HubTile.SHIFT) },
                            modifier,
                            enabled = !state.replacementBlocked,
                            statusTone = Tone.Neutral,
                        )
                    },
                    HubTile.INVENTORY to { modifier ->
                        Tile(
                            Icons.Outlined.Inventory2,
                            stringResource(R.string.hub_tile_inventory),
                            state.continueInventoryNumber?.let { stringResource(R.string.hub_inventory_continue, it) } ?: (inventoriesLabel(state.inventories) + stamp),
                            { if (!state.replacementTargetWaiting && (!state.replacementBlocked || state.activeInventoryId != null)) onTile(HubTile.INVENTORY) },
                            modifier,
                            enabled = !state.replacementTargetWaiting && (!state.replacementBlocked || state.activeInventoryId != null),
                            statusTone = if (state.continueInventoryNumber != null) Tone.Ok else Tone.Neutral,
                        )
                    },
                    HubTile.WRITEOFF to { modifier ->
                        Tile(
                            Icons.Outlined.RemoveShoppingCart,
                            stringResource(R.string.hub_tile_writeoff),
                            when {
                                state.canWriteoff == false -> stringResource(R.string.hub_writeoff_no_permission)
                                state.writeoffPending > 0 ->
                                    pluralStringResource(R.plurals.hub_writeoff_pending, state.writeoffPending, state.writeoffPending)
                                else -> ""
                            },
                            { if (!state.replacementBlocked) onTile(HubTile.WRITEOFF) },
                            modifier,
                            enabled = !state.replacementBlocked,
                            statusTone = if (state.canWriteoff == false || state.writeoffPending > 0) Tone.Warn else Tone.Neutral,
                        )
                    },
                    HubTile.PALLETS to { modifier ->
                        Tile(
                            Icons.Outlined.Layers,
                            stringResource(R.string.hub_tile_pallets),
                            when {
                                state.canBuildPallets == false -> stringResource(R.string.hub_pallets_no_permission)
                                state.palletsPending > 0 ->
                                    pluralStringResource(R.plurals.hub_pallets_pending, state.palletsPending, state.palletsPending)
                                else -> ""
                            },
                            { onTile(HubTile.PALLETS) },
                            modifier,
                            statusTone = if (state.canBuildPallets == false || state.palletsPending > 0) Tone.Warn else Tone.Neutral,
                        )
                    },
                    HubTile.SETTINGS to { modifier ->
                        Tile(
                            Icons.Outlined.Settings,
                            stringResource(R.string.hub_tile_settings),
                            if (state.missingPrinterPurposes.isNotEmpty()) stringResource(R.string.printer_missing_purposes,
                                state.missingPrinterPurposes.map { stringResource(app.markiro.handheld.feature.printer.purposeLabel(it)) }.joinToString(", "))
                            else if (state.printerAttentionPurposes.isNotEmpty()) stringResource(R.string.printer_attention_purposes,
                                state.printerAttentionPurposes.map { stringResource(app.markiro.handheld.feature.printer.purposeLabel(it)) }.joinToString(", "))
                            else if (state.printerConfigured) "" else stringResource(R.string.hub_printer_not_set),
                            { onTile(HubTile.SETTINGS) },
                            modifier,
                            statusTone = if (state.printerConfigured) Tone.Neutral else Tone.Warn,
                        )
                    },
                )
                val tiles = visibleTiles(state.hostMode).map { byTile.getValue(it) }
                // A narrow handheld (or enlarged system text) needs the full width
                // for names such as «Инвентаризация» instead of splitting a word.
                tiles.chunked(columns).forEach { rowTiles ->
                    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Max), horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3)) {
                        rowTiles.forEach { tile -> tile(Modifier.weight(1f).fillMaxHeight()) }
                        if (rowTiles.size < columns) Spacer(Modifier.weight(1f))
                    }
                }
            }
        }
    }
}

/** The tiles of the hub: a host has no inventory and no write-off (spec 8.7: hidden by `backend`, not deleted). */
internal fun visibleTiles(hostMode: Boolean): List<HubTile> =
    if (hostMode) listOf(HubTile.SHIFT, HubTile.PALLETS, HubTile.SETTINGS)
    else listOf(HubTile.SHIFT, HubTile.INVENTORY, HubTile.WRITEOFF, HubTile.PALLETS, HubTile.SETTINGS)

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
