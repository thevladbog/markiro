package app.markiro.handheld.feature.work

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material.icons.outlined.Wifi
import androidx.compose.material.icons.outlined.WifiOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.markiro.handheld.R
import app.markiro.handheld.core.design.Banner
import app.markiro.handheld.core.design.HeaderStatus
import app.markiro.handheld.core.design.IconAction
import app.markiro.handheld.core.design.MarkiroSizes
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.design.StatusItem
import app.markiro.handheld.core.design.Tone
import app.markiro.handheld.core.sets.SetScanStatus
import app.markiro.handheld.core.sets.decodeSetItems
import app.markiro.handheld.core.sets.setCodeOrNull
import app.markiro.handheld.core.storage.SetAssemblyCounts

data class SetAssemblyUi(
    val draft: List<String> = emptyList(),
    val counts: SetAssemblyCounts = SetAssemblyCounts(0, 0, 0),
    val feedback: SetScanStatus? = null,
)

@Composable
fun SetAssemblyScreen(
    state: WorkUi,
    assembly: SetAssemblyUi,
    onLeave: () -> Unit,
    onClose: () -> Unit,
    onRemove: (Int, String) -> Unit,
) {
    val shift = state.shift ?: return
    val colors = MarkiroTheme.colors
    val type = MarkiroTheme.type
    val recipe = remember(shift.setItemsJson) { shift.setItemsJson.decodeSetItems() }
    val parsed = remember(assembly.draft) { assembly.draft.mapNotNull(::setCodeOrNull) }
    val counts = remember(parsed) { parsed.groupingBy { it.gtin14 }.eachCount() }
    val expected = recipe.sumOf { it.quantity }
    val remaining = expected - parsed.size
    val feedback = assembly.feedback
    val awaitingPackage = expected > 0 && remaining == 0 && feedback != SetScanStatus.CLOSED
    val listState = rememberLazyListState()
    LaunchedEffect(awaitingPackage) {
        if (awaitingPackage) listState.scrollToItem(0)
    }
    var menu by remember { mutableStateOf(false) }
    var removing by remember { mutableStateOf(false) }
    val connectivity = if (state.reachable) stringResource(R.string.hub_network) else stringResource(R.string.hub_offline_banner)
    val queue = stringResource(R.string.set_queue, assembly.counts.queued)

    Column(Modifier.fillMaxSize().background(colors.surfacePage)) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = MarkiroSizes.sp4),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(shift.number, Modifier.weight(1f), color = colors.fg3, style = type.caption)
            HeaderStatus(
                listOf(
                    StatusItem(if (state.reachable) Icons.Outlined.Wifi else Icons.Outlined.WifiOff, connectivity, if (state.reachable) Tone.Ok else Tone.Warn),
                    StatusItem(Icons.Outlined.Sync, queue, if (assembly.counts.queued > 0) Tone.Warn else Tone.Neutral),
                ),
                if (state.reachable) Tone.Ok else Tone.Warn,
                assembly.counts.queued,
            )
            Box {
                IconAction(Icons.Outlined.MoreVert, stringResource(R.string.set_menu)) { menu = true }
                DropdownMenu(menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.set_remove)) },
                        enabled = assembly.draft.isNotEmpty(),
                        onClick = { menu = false; removing = true },
                    )
                    DropdownMenuItem(text = { Text(stringResource(R.string.work_leave)) }, onClick = onLeave)
                    DropdownMenuItem(
                        text = { Text(stringResource(if (state.strip != null) R.string.work_close_part else R.string.work_close)) },
                        enabled = assembly.draft.isEmpty(),
                        onClick = onClose,
                    )
                }
            }
        }

        LazyColumn(
            Modifier.fillMaxWidth(),
            state = listState,
            contentPadding = PaddingValues(horizontal = MarkiroSizes.sp4, vertical = MarkiroSizes.sp2),
            verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2),
        ) {
            item { Text(shift.productName ?: shift.productId, style = type.title, color = colors.fg1) }
            if (awaitingPackage) item { PackageScanPrompt() }
            if (!state.reachable) item {
                Banner(if (assembly.counts.queued > 0) stringResource(R.string.set_offline_queue, assembly.counts.queued) else connectivity,
                    Tone.Warn, Icons.Outlined.WifiOff)
            }
            if (assembly.counts.conflicts > 0) item {
                Banner(stringResource(R.string.set_conflicts, assembly.counts.conflicts), Tone.Err, Icons.Outlined.ErrorOutline)
            }
            if (feedback == SetScanStatus.CLOSED) item {
                Banner(
                    stringResource(if (state.reachable) R.string.set_saved else R.string.set_saved_offline),
                    Tone.Ok,
                    Icons.Outlined.CheckCircle,
                )
            } else if (feedback != null && feedback != SetScanStatus.ITEM_ADDED) item {
                val label = when (feedback) {
                    SetScanStatus.INCOMPLETE -> stringResource(R.string.set_incomplete, remaining)
                    SetScanStatus.EXTRA -> stringResource(R.string.set_extra)
                    SetScanStatus.DUPLICATE -> stringResource(R.string.set_duplicate)
                    SetScanStatus.WRONG_PRODUCT -> stringResource(R.string.set_wrong_product)
                    SetScanStatus.TOO_LARGE -> stringResource(R.string.set_too_large)
                    else -> stringResource(R.string.set_invalid)
                }
                Banner(label, Tone.Warn, Icons.Outlined.ErrorOutline)
            }
            if (!awaitingPackage) item {
                Banner(stringResource(R.string.set_scan_items), Tone.Neutral, Icons.Outlined.QrCodeScanner)
            }
            item {
                Row(
                    Modifier.fillMaxWidth().padding(top = MarkiroSizes.sp1),
                    horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    val title = if (feedback == SetScanStatus.CLOSED) R.string.set_next else R.string.set_contents
                    Text(stringResource(title), Modifier.weight(1f), style = type.strong, color = colors.fg1)
                    Text(stringResource(R.string.set_fraction, parsed.size, expected), style = type.code,
                        color = if (awaitingPackage) colors.okFg else colors.fg1)
                }
            }
            items(recipe, key = { it.gtin14 }) { item ->
                val filled = counts.getOrDefault(item.gtin14, 0)
                val complete = filled == item.quantity
                val color = if (complete) colors.okFg else colors.fg1
                Row(
                    Modifier.fillMaxWidth().heightIn(min = MarkiroSizes.controlRow).clip(RoundedCornerShape(MarkiroSizes.radius))
                        .background(colors.surfaceCard).padding(horizontal = MarkiroSizes.sp3, vertical = MarkiroSizes.sp2),
                    horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(item.productName, style = type.strong, color = colors.fg1)
                        val hint = when {
                            complete -> stringResource(R.string.set_item_done)
                            filled == 0 -> stringResource(R.string.set_item_waiting)
                            else -> stringResource(R.string.set_item_remaining, item.quantity - filled)
                        }
                        Text(hint, style = type.caption, color = if (complete) colors.okFg else colors.fg2)
                    }
                    Text(stringResource(R.string.set_fraction, filled, item.quantity), style = type.code, color = color)
                }
            }
            item {
                Column(Modifier.fillMaxWidth().padding(top = MarkiroSizes.sp1)) {
                    HorizontalDivider(color = colors.line)
                    Row(
                        Modifier.fillMaxWidth().padding(top = MarkiroSizes.sp2),
                        horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(stringResource(R.string.set_shift_total), Modifier.weight(1f), style = type.body, color = colors.fg2)
                        Text(state.total.toString(), style = type.code, color = colors.fg1)
                    }
                    if (state.reachable && assembly.counts.queued > 0) {
                        Text(queue, style = type.caption, color = colors.warnFg)
                    }
                }
            }
        }
    }

    if (removing && assembly.draft.isNotEmpty()) {
        AlertDialog(
            onDismissRequest = { removing = false },
            title = { Text(stringResource(R.string.set_remove)) },
            text = {
                val names = recipe.associate { it.gtin14 to it.productName }
                LazyColumn(Modifier.heightIn(max = 280.dp)) {
                    items(assembly.draft.indices.toList()) { index ->
                        val raw = assembly.draft[index]
                        val code = setCodeOrNull(raw)
                        TextButton(onClick = { removing = false; onRemove(index, raw) }) {
                            Text(if (code == null) stringResource(R.string.set_invalid) else
                                "${names[code.gtin14] ?: code.gtin14} · …${code.serial.takeLast(6)}")
                        }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { removing = false }) { Text(stringResource(R.string.common_cancel)) } },
        )
    }
}

@Composable
private fun PackageScanPrompt() {
    val colors = MarkiroTheme.colors
    val type = MarkiroTheme.type
    val shape = RoundedCornerShape(MarkiroSizes.radiusCard)
    Row(
        Modifier.fillMaxWidth()
            .semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite }
            .clip(shape)
            .background(colors.okBg)
            .border(1.dp, colors.okBorder, shape)
            .padding(horizontal = MarkiroSizes.sp4, vertical = MarkiroSizes.sp5),
        horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(MarkiroSizes.controlPrimary).clip(RoundedCornerShape(MarkiroSizes.radius)).background(colors.okSolid),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                Icons.Outlined.QrCodeScanner,
                contentDescription = null,
                tint = colors.fgOnOk,
                modifier = Modifier.size(MarkiroSizes.sp6 + MarkiroSizes.sp3).testTag("set-package-scan-icon"),
            )
        }
        Column(Modifier.weight(1f)) {
            Text(stringResource(R.string.set_scan_package), style = type.title, color = colors.okFg)
            Text(stringResource(R.string.set_scan_package_hint), style = type.body, color = colors.fg1)
        }
    }
}
