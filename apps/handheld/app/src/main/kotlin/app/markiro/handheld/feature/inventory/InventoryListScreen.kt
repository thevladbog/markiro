package app.markiro.handheld.feature.inventory

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Inventory2
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material.icons.outlined.WifiOff
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.markiro.handheld.R
import app.markiro.handheld.core.design.AppBar
import app.markiro.handheld.core.design.Banner
import app.markiro.handheld.core.design.FullScreenState
import app.markiro.handheld.core.design.IconAction
import app.markiro.handheld.core.design.MarkiroChip
import app.markiro.handheld.core.design.MarkiroSizes
import app.markiro.handheld.core.design.MarkiroTextButton
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.design.PrimaryButton
import app.markiro.handheld.core.design.StateAction
import app.markiro.handheld.core.design.Tone
import app.markiro.handheld.core.network.InventoryTaskDto
import app.markiro.handheld.core.storage.InventoryTaskEntity
import app.markiro.handheld.core.util.TimeText
import java.text.NumberFormat

data class InventoryListCallbacks(
    val onBack: () -> Unit = {},
    val onContinue: () -> Unit = {},
    val onSelect: (InventoryTaskDto) -> Unit = {},
    val onExpandOthers: () -> Unit = {},
    val onConfirmOther: () -> Unit = {},
    val onDismiss: () -> Unit = {},
    val onRetry: () -> Unit = {},
    val onRefresh: () -> Unit = {},
)

data class InventoryCard(
    val id: String,
    val number: String,
    val product: String,
    val repack: Boolean,
    val dates: String,
    val lineName: String?,
    val active: Boolean,
    val enabled: Boolean,
)

private fun InventoryTaskDto.card(reachable: Boolean, lineName: String? = null) = InventoryCard(
    inventoryId, inventoryNumber, productPrintName ?: productName, mode == "repack",
    "${civilDate(productionDateFrom)} – ${civilDate(productionDateTo)}", lineName, false, mode == "check" && reachable,
)

private fun InventoryTaskEntity.card() = InventoryCard(
    inventoryId, inventoryNumber, productPrintName ?: productName, false,
    "${civilDate(productionDateFrom)} – ${civilDate(productionDateTo)}", null, true, true,
)

fun errorText(kind: InventoryError): Int = when (kind) {
    InventoryError.NOT_RUNNING -> R.string.inventory_not_running
    InventoryError.OPERATOR_UNAVAILABLE -> R.string.inventory_operator_unavailable
    InventoryError.LINE_REQUIRED -> R.string.inventory_line_required
    InventoryError.BARCODE_UNKNOWN -> R.string.inventory_barcode_unknown
    InventoryError.NEEDS_NETWORK -> R.string.inventory_snapshot_needs_network
    InventoryError.DOWNLOAD_FAILED -> R.string.inventory_download_failed
    InventoryError.INVALID_SNAPSHOT -> R.string.inventory_download_invalid
    InventoryError.REPACK -> R.string.inventory_repack_later
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InventoryListScreen(state: InventoryListUi, cb: InventoryListCallbacks) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    val numbers = NumberFormat.getIntegerInstance()
    Column(Modifier.fillMaxSize().background(c.surfacePage)) {
        when (val d = state.dialog) {
            is InventoryDialog.ConfirmOther -> {
                AppBar(stringResource(R.string.inventory_title), cb.onDismiss)
                Column(Modifier.padding(MarkiroSizes.sp4), verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3)) {
                    Text(stringResource(R.string.inventory_join_other_title), style = t.title, color = c.fg1)
                    Text(stringResource(R.string.inventory_join_other_this, state.ownLineName.orEmpty()), style = t.body, color = c.fg1)
                    Text(stringResource(R.string.inventory_join_other_task, d.task.lineName), style = t.body, color = c.fg1)
                    Text(stringResource(R.string.inventory_join_other_text), style = t.caption, color = c.warnFg)
                    PrimaryButton(stringResource(R.string.inventory_join_other_confirm, d.task.inventoryNumber), cb.onConfirmOther)
                    MarkiroTextButton(stringResource(R.string.common_cancel), cb.onDismiss)
                }
                return
            }
            InventoryDialog.Joining -> {
                AppBar(stringResource(R.string.inventory_title))
                FullScreenState(Icons.Outlined.Sync, stringResource(R.string.inventory_joining), "", tone = Tone.Info)
                return
            }
            is InventoryDialog.Downloading -> {
                AppBar(stringResource(R.string.inventory_title))
                Column(
                    Modifier.fillMaxSize().padding(MarkiroSizes.sp4),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) {
                    Text(stringResource(R.string.inventory_download_title, d.number), style = t.title, color = c.fg1)
                    Text(stringResource(R.string.inventory_download_progress, numbers.format(d.staged), numbers.format(d.total)), style = t.body, color = c.fg2)
                    LinearProgressIndicator(
                        progress = { if (d.total == 0) 0f else d.staged.toFloat() / d.total },
                        modifier = Modifier.fillMaxWidth().padding(top = MarkiroSizes.sp4),
                        color = c.accent,
                    )
                }
                return
            }
            is InventoryDialog.Error -> {
                AppBar(stringResource(R.string.inventory_title), cb.onDismiss)
                val text = if (d.kind == InventoryError.INVALID_SNAPSHOT) {
                    stringResource(errorText(d.kind), d.detail.orEmpty())
                } else {
                    stringResource(errorText(d.kind))
                }
                FullScreenState(
                    if (d.kind == InventoryError.NEEDS_NETWORK) Icons.Outlined.WifiOff else Icons.Outlined.ErrorOutline,
                    text,
                    "",
                    primary = if (d.retry != null) {
                        StateAction(stringResource(R.string.common_retry), cb.onRetry)
                    } else {
                        StateAction(stringResource(R.string.common_got_it), cb.onDismiss)
                    },
                    secondary = if (d.retry != null) StateAction(stringResource(R.string.common_cancel), cb.onDismiss) else null,
                    tone = Tone.Err,
                    primaryIsAccent = d.retry != null,
                )
                return
            }
            null -> Unit
        }
        // Same pair as the shift list: `onRefresh` existed but the only way to
        // reach it was to hit an error first.
        AppBar(stringResource(R.string.inventory_title), cb.onBack) {
            IconAction(Icons.Outlined.Refresh, stringResource(R.string.common_refresh), cb.onRefresh)
        }
        if (!state.reachable && state.listFetchedAt != null) {
            Text(
                stringResource(R.string.common_data_as_of, TimeText.hhmm(state.listFetchedAt)),
                style = t.caption,
                color = c.warnFg,
                modifier = Modifier.padding(horizontal = MarkiroSizes.sp4),
            )
        }
        if (state.refreshFailed) {
            Banner(stringResource(R.string.common_refresh_failed), Tone.Warn, Icons.Outlined.CloudOff)
        }
        if (!state.loading && state.active == null && state.mine.isEmpty() && !state.othersExpanded) {
            FullScreenState(Icons.Outlined.Inventory2, stringResource(R.string.inventory_empty_title), stringResource(R.string.inventory_empty_text))
            return
        }
        PullToRefreshBox(isRefreshing = state.loading, onRefresh = cb.onRefresh, modifier = Modifier.fillMaxSize()) {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(MarkiroSizes.sp4), verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3)) {
                state.active?.let { active ->
                    item {
                        Column(verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2)) {
                            InventoryCardView(active.card(), onClick = cb.onContinue)
                            PrimaryButton(stringResource(R.string.common_continue), cb.onContinue)
                        }
                    }
                }
                if (state.mine.isNotEmpty()) {
                    item { Text(stringResource(R.string.inventory_my_line), style = t.label, color = c.fg3) }
                    items(state.mine, key = { it.inventoryId }) { task -> InventoryCardView(task.card(state.reachable), onClick = { cb.onSelect(task) }) }
                }
                if (state.loading) item { Text(stringResource(R.string.inventory_loading), style = t.caption, color = c.fg3) }
                if (!state.othersExpanded) {
                    item { MarkiroTextButton(stringResource(R.string.inventory_show_other), cb.onExpandOthers) }
                } else {
                    item { Text(stringResource(R.string.inventory_other_lines), style = t.label, color = c.fg3) }
                    if (state.othersLoading) item { Text(stringResource(R.string.inventory_loading), style = t.caption, color = c.fg3) }
                    if (state.othersFailed) {
                        item { Text(stringResource(R.string.common_other_lines_failed), style = t.caption, color = c.warnFg) }
                    }
                    state.others.forEach { (line, tasks) ->
                        items(tasks, key = { "$line:${it.inventoryId}" }) { task -> InventoryCardView(task.card(state.reachable, line), onClick = { cb.onSelect(task) }) }
                    }
                }
            }
        }
    }
}

@Composable
fun InventoryCardView(card: InventoryCard, onClick: () -> Unit) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    val shape = RoundedCornerShape(MarkiroSizes.radius)
    Column(
        Modifier.fillMaxWidth().heightIn(min = 96.dp).clip(shape).background(c.surfaceCard)
            .border(1.dp, if (card.active) c.accent else c.line, shape)
            .clickable(enabled = card.enabled, onClick = onClick)
            .alpha(if (card.enabled) 1f else 0.55f)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp1),
    ) {
        Row(horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Text(card.number, style = t.code.copy(fontSize = 16.sp), color = c.fg1)
            Row(horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp1)) {
                MarkiroChip(stringResource(if (card.repack) R.string.inventory_mode_repack else R.string.inventory_mode_check), Tone.Neutral)
                card.lineName?.let { MarkiroChip(it, Tone.Info) }
                if (card.active) MarkiroChip(stringResource(R.string.inventory_continue), Tone.Ok)
            }
        }
        Text(card.product, style = t.strong.copy(fontSize = 16.sp), color = c.fg1)
        Text(card.dates, style = t.caption, color = c.fg3)
        if (card.repack) {
            Text(stringResource(R.string.inventory_repack_later), style = t.caption, color = c.warnFg)
        } else if (!card.enabled && !card.active) {
            Text(stringResource(R.string.inventory_needs_network), style = t.caption, color = c.warnFg)
        }
    }
}
