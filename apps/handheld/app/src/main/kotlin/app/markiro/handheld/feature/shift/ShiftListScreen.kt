package app.markiro.handheld.feature.shift

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
import androidx.compose.material.icons.outlined.Factory
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material.icons.outlined.SystemUpdate
import androidx.compose.material.icons.outlined.WifiOff
import androidx.compose.material3.Text
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
import app.markiro.handheld.core.design.FullScreenState
import app.markiro.handheld.core.design.MarkiroChip
import app.markiro.handheld.core.design.MarkiroSizes
import app.markiro.handheld.core.design.MarkiroTextButton
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.design.PrimaryButton
import app.markiro.handheld.core.design.StateAction
import app.markiro.handheld.core.design.Tone
import app.markiro.handheld.core.network.ShiftDto
import app.markiro.handheld.core.storage.ShiftEntity
import app.markiro.handheld.core.util.TimeText

data class ShiftListCallbacks(
    val onBack: () -> Unit = {},
    val onContinue: () -> Unit = {},
    val onSelect: (ShiftEntity) -> Unit = {},
    val onExpandOthers: () -> Unit = {},
    val onSelectOther: (ShiftDto, String) -> Unit = { _, _ -> },
    val onConfirmOther: () -> Unit = {},
    val onDismiss: () -> Unit = {},
    val onRefresh: () -> Unit = {},
)

/** Card content shared by cached rows and other-line rows. */
data class ShiftCard(
    val id: String,
    val number: String,
    val product: String,
    val plan: Int?,
    val aggregation: Boolean,
    val lineName: String?,
    val tolling: String?,
    val active: Boolean,
    val enabled: Boolean,
    val disabledReason: Int?,
)

private fun ShiftEntity.card(reachable: Boolean) = ShiftCard(
    id = id,
    number = number,
    product = productPrintName ?: productName ?: productId,
    plan = plannedQty,
    aggregation = mode == "aggregation",
    lineName = lineName,
    tolling = counterpartyName,
    active = status == "active",
    enabled = bundleFetchedAt != null || reachable,
    disabledReason = if (bundleFetchedAt == null && !reachable) R.string.shifts_needs_network else null,
)

private fun ShiftDto.card(reachable: Boolean, lineName: String) = ShiftCard(
    id = id,
    number = number,
    product = productPrintName ?: productName ?: productId,
    plan = plannedQty,
    aggregation = mode == "aggregation",
    lineName = lineName,
    tolling = counterpartyName,
    active = status == "active",
    enabled = reachable,
    disabledReason = if (!reachable) R.string.shifts_needs_network else null,
)

@Composable
fun ShiftListScreen(state: ShiftListUi, cb: ShiftListCallbacks) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Column(Modifier.fillMaxSize().background(c.surfacePage)) {
        when (val d = state.dialog) {
            is ShiftDialog.ConfirmOther -> {
                AppBar(stringResource(R.string.shifts_title), cb.onDismiss)
                FullScreenState(
                    Icons.Outlined.Factory,
                    stringResource(R.string.shifts_join_other_title),
                    stringResource(R.string.shifts_join_other_text, d.shift.number, d.lineName, state.ownLineName.orEmpty()),
                    primary = StateAction(stringResource(R.string.shifts_enter), cb.onConfirmOther),
                    secondary = StateAction(stringResource(R.string.common_cancel), cb.onDismiss),
                )
                return
            }
            ShiftDialog.Entering -> {
                AppBar(stringResource(R.string.shifts_title))
                FullScreenState(Icons.Outlined.Sync, stringResource(R.string.shifts_entering), "", tone = Tone.Info)
                return
            }
            ShiftDialog.UpdateRequired -> {
                AppBar(stringResource(R.string.shifts_title), cb.onDismiss)
                FullScreenState(
                    Icons.Outlined.SystemUpdate,
                    stringResource(R.string.shifts_update_required_title),
                    stringResource(R.string.shifts_update_required_text),
                    primary = StateAction(stringResource(R.string.common_got_it), cb.onDismiss),
                    tone = Tone.Warn,
                    primaryIsAccent = false,
                )
                return
            }
            ShiftDialog.Closed -> {
                AppBar(stringResource(R.string.shifts_title), cb.onDismiss)
                FullScreenState(
                    Icons.Outlined.Factory,
                    stringResource(R.string.shifts_closed_title),
                    stringResource(R.string.shifts_closed_text),
                    primary = StateAction(stringResource(R.string.common_got_it), cb.onDismiss),
                    primaryIsAccent = false,
                )
                return
            }
            ShiftDialog.Unavailable -> {
                AppBar(stringResource(R.string.shifts_title), cb.onDismiss)
                FullScreenState(
                    Icons.Outlined.WifiOff,
                    stringResource(R.string.common_server_unavailable),
                    stringResource(R.string.shifts_needs_network),
                    primary = StateAction(stringResource(R.string.common_retry), cb.onRefresh),
                    secondary = StateAction(stringResource(R.string.common_cancel), cb.onDismiss),
                    tone = Tone.Err,
                )
                return
            }
            null -> Unit
        }
        AppBar(stringResource(R.string.shifts_title), cb.onBack)
        if (!state.reachable && state.listFetchedAt != null) {
            Text(
                stringResource(R.string.common_data_as_of, TimeText.hhmm(state.listFetchedAt)),
                style = t.caption,
                color = c.warnFg,
                modifier = Modifier.padding(horizontal = MarkiroSizes.sp4),
            )
        }
        if (!state.loading && state.continueShift == null && state.mine.isEmpty() && !state.othersExpanded) {
            FullScreenState(Icons.Outlined.Factory, stringResource(R.string.shifts_empty_title), stringResource(R.string.shifts_empty_text))
            return
        }
        LazyColumn(
            Modifier.fillMaxSize(),
            contentPadding = PaddingValues(MarkiroSizes.sp4),
            verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3),
        ) {
            state.continueShift?.let { current ->
                item {
                    Column(verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2)) {
                        ShiftCardView(current.card(true), onClick = cb.onContinue)
                        PrimaryButton(stringResource(R.string.common_continue), cb.onContinue)
                    }
                }
            }
            if (state.mine.isNotEmpty()) {
                item { Text(stringResource(R.string.shifts_my_line), style = t.label, color = c.fg3) }
                items(state.mine, key = { it.id }) { shift -> ShiftCardView(shift.card(state.reachable), onClick = { cb.onSelect(shift) }) }
            }
            if (state.loading) item { Text(stringResource(R.string.shifts_loading), style = t.caption, color = c.fg3) }
            if (!state.othersExpanded) {
                item { MarkiroTextButton(stringResource(R.string.shifts_show_other), cb.onExpandOthers) }
            } else {
                item { Text(stringResource(R.string.shifts_other_lines), style = t.label, color = c.fg3) }
                if (state.othersLoading) item { Text(stringResource(R.string.shifts_loading), style = t.caption, color = c.fg3) }
                state.others.forEach { line ->
                    items(line.shifts, key = { "${line.id}:${it.id}" }) { dto ->
                        ShiftCardView(dto.card(state.reachable, line.name), onClick = { cb.onSelectOther(dto, line.name) })
                    }
                }
            }
        }
    }
}

@Composable
fun ShiftCardView(card: ShiftCard, onClick: () -> Unit) {
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
                MarkiroChip(stringResource(R.string.shifts_mode_validation), Tone.Neutral)
                if (card.aggregation) MarkiroChip(stringResource(R.string.shifts_mode_aggregation), Tone.Info)
                if (card.active) MarkiroChip(stringResource(R.string.shifts_status_active), Tone.Ok)
            }
        }
        Text(card.product, style = t.strong.copy(fontSize = 16.sp), color = c.fg1)
        Text(
            listOfNotNull(
                card.plan?.let { stringResource(R.string.shifts_plan, it) } ?: stringResource(R.string.shifts_no_plan),
                card.lineName,
                card.tolling?.let { stringResource(R.string.shifts_tolling, it) },
            ).joinToString(" · "),
            style = t.caption,
            color = c.fg3,
        )
        card.disabledReason?.let { Text(stringResource(it), style = t.caption, color = c.warnFg) }
    }
}
