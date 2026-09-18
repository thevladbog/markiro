package app.markiro.handheld.feature.pallets

import androidx.compose.foundation.background
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
import androidx.compose.material.icons.outlined.Inventory2
import androidx.compose.material.icons.outlined.Layers
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material.icons.outlined.Refresh
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
import app.markiro.handheld.core.design.FullScreenState
import app.markiro.handheld.core.design.IconAction
import app.markiro.handheld.core.design.MarkiroChip
import app.markiro.handheld.core.design.MarkiroSizes
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.design.ScreenColumn
import app.markiro.handheld.core.design.SecondaryButton
import app.markiro.handheld.core.design.StateAction
import app.markiro.handheld.core.design.Tone
import app.markiro.handheld.core.storage.MembershipStatus
import app.markiro.handheld.core.storage.PalletEntity
import app.markiro.handheld.core.storage.PalletMembershipEntity
import app.markiro.handheld.core.util.TimeText
import app.markiro.handheld.feature.work.PalletCloseCallbacks
import app.markiro.handheld.feature.work.PalletCloseScreen
import app.markiro.handheld.feature.work.PalletCloseStep
import app.markiro.handheld.feature.work.PalletStrip

data class PalletsCallbacks(
    val onBack: () -> Unit = {},
    val onRemove: (String) -> Unit = {},
    val onEarlyClose: () -> Unit = {},
    val onCancelEarlyClose: () -> Unit = {},
    val onConfirmEarlyClose: () -> Unit = {},
    val onAcknowledge: (String) -> Unit = {},
    val onReprint: (String) -> Unit = {},
    val onRefresh: () -> Unit = {},
    val onDisassemble: () -> Unit = {},
    val close: PalletCloseCallbacks = PalletCloseCallbacks(),
)

/**
 * The whole «Паллеты» mode, chosen by state rather than by route, the way
 * `WriteoffRoute` is: a closed pallet's label and a refusal are states of this
 * screen, so hardware Back can dismiss them without leaving the mode.
 *
 * There is no full-screen flash per scan. In a warehouse the operator's hands
 * are on the box and the answer they act on is the sound; the verdict banner
 * is what they read when the sound was not enough.
 */
@Composable
fun PalletsRoute(state: PalletsUi, cb: PalletsCallbacks) {
    state.blocked?.let { return PalletsBlockedScreen(it, cb.onBack) }
    if (state.closeStep !is PalletCloseStep.Idle) return PalletCloseScreen(state.closeStep, cb.close)
    if (state.confirmEarlyClose) {
        AlertDialog(
            onDismissRequest = cb.onCancelEarlyClose,
            title = { Text(stringResource(R.string.pallet_close_confirm_title), color = MarkiroTheme.colors.fg1) },
            text = {
                Text(
                    stringResource(R.string.pallet_close_confirm_body, state.boxCount, state.capacity ?: state.boxCount),
                    color = MarkiroTheme.colors.fg2,
                )
            },
            confirmButton = {
                TextButton(onClick = cb.onConfirmEarlyClose) { Text(stringResource(R.string.pallet_close_confirm_confirm)) }
            },
            dismissButton = { TextButton(onClick = cb.onCancelEarlyClose) { Text(stringResource(R.string.common_cancel)) } },
            containerColor = MarkiroTheme.colors.surfacePanel,
        )
    }
    PalletsListScreen(state, cb)
}

@Composable
private fun PalletsBlockedScreen(blocked: PalletsBlocked, onBack: () -> Unit) {
    val (title, text) = when (blocked) {
        PalletsBlocked.NO_PERMISSION -> R.string.pallets_blocked_permission_title to R.string.pallets_blocked_permission_text
        PalletsBlocked.NEVER_SYNCED -> R.string.pallets_blocked_sync_title to R.string.pallets_blocked_sync_text
    }
    FullScreenState(
        icon = Icons.Outlined.Warning,
        title = stringResource(title),
        text = stringResource(text),
        primary = StateAction(stringResource(R.string.pallets_to_hub), onBack),
        tone = Tone.Warn,
    )
}

@Composable
private fun PalletsListScreen(state: PalletsUi, cb: PalletsCallbacks) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Column(Modifier.fillMaxWidth().background(c.surfacePage)) {
        AppBar(stringResource(R.string.pallets_title), onBack = cb.onBack) {
            // Any closed pallet of this device, not only the one on screen: the
            // stack being taken apart is usually one built a while ago. Disabled
            // with nothing closed yet, so the action does not open onto an
            // instant «Нет закрытых паллет» refusal screen.
            val hasClosedPallet = state.closedPalletCount > 0
            IconAction(
                icon = Icons.Outlined.Layers,
                description = stringResource(R.string.exceptions_disassemble_pallet) +
                    if (hasClosedPallet) "" else " " + stringResource(R.string.exceptions_no_closed_pallets),
                enabled = hasClosedPallet,
                onClick = cb.onDisassemble,
            )
            IconAction(Icons.Outlined.Refresh, stringResource(R.string.pallets_refresh), onClick = cb.onRefresh)
        }
        state.stampAt?.let {
            Text(
                stringResource(R.string.common_data_as_of, TimeText.hhmm(it)),
                style = t.caption,
                color = c.fg3,
                modifier = Modifier.padding(horizontal = MarkiroSizes.sp4, vertical = MarkiroSizes.sp1),
            )
        }
        if (state.rejections.isNotEmpty()) RejectionsBlock(state.rejections, state.rejectionPallets, cb)
        state.lastVerdict?.let { VerdictRow(it) }
        if (state.pallet == null) {
            FullScreenState(
                icon = Icons.Outlined.QrCodeScanner,
                title = stringResource(R.string.pallets_empty_title),
                text = stringResource(R.string.pallets_empty_text),
            )
            return@Column
        }
        ScreenColumn(
            padding = PaddingValues(MarkiroSizes.sp4),
            verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2),
        ) {
            // A pallet whose product carries no capacity still counts its boxes;
            // it simply has no target to count towards.
            if (state.capacity != null) {
                PalletStrip(state.boxCount, state.capacity)
            } else {
                Text(
                    pluralStringResource(R.plurals.pallets_count_no_capacity, state.boxCount, state.boxCount),
                    style = t.strong,
                    color = c.fg2,
                )
            }
            if (state.productName.isNotEmpty()) Text(state.productName, style = t.caption, color = c.fg3)
            // Newest first: the box just scanned is the one the operator checks.
            state.members.asReversed().forEach { member -> MemberRow(member) { cb.onRemove(member.sscc) } }
            Spacer(Modifier.height(MarkiroSizes.sp2))
            SecondaryButton(stringResource(R.string.work_close_pallet_early), cb.onEarlyClose)
        }
    }
}

@Composable
private fun VerdictRow(verdict: PalletVerdict) {
    val (tone, text) = when (verdict) {
        is PalletVerdict.Attached -> Tone.Ok to stringResource(R.string.pallets_verdict_attached, verdict.tail)
        is PalletVerdict.AlreadyHere -> Tone.Warn to stringResource(R.string.pallets_verdict_already, verdict.tail)
        is PalletVerdict.OnPallet -> Tone.Err to (
            verdict.palletTail?.let { stringResource(R.string.pallets_verdict_on_pallet, it) }
                ?: stringResource(R.string.pallets_verdict_on_open_pallet)
            )
        PalletVerdict.OnLocalPallet -> Tone.Err to stringResource(R.string.pallets_verdict_on_local)
        is PalletVerdict.OtherProduct -> Tone.Err to stringResource(R.string.pallets_verdict_other_product, verdict.name)
        PalletVerdict.UnknownBox -> Tone.Err to stringResource(R.string.pallets_verdict_unknown_box)
        PalletVerdict.UnknownProduct -> Tone.Err to stringResource(R.string.pallets_verdict_unknown_product)
        PalletVerdict.IsPallet -> Tone.Err to stringResource(R.string.pallets_verdict_is_pallet)
        PalletVerdict.UnitCode -> Tone.Err to stringResource(R.string.pallets_verdict_unit_code)
        PalletVerdict.NotACode -> Tone.Err to stringResource(R.string.pallets_verdict_not_a_code)
        PalletVerdict.Unavailable -> Tone.Err to stringResource(R.string.pallets_verdict_unavailable)
    }
    Banner(text, tone, if (tone == Tone.Ok) Icons.Outlined.CheckCircle else Icons.Outlined.Warning)
}

/**
 * What the server refused, and what to do about it.
 *
 * Grouped by pallet, because a rejection is not tied to whatever is open now.
 * A membership can still be pending when its pallet is closed and its label
 * printed, and the label states the box count: if the server then refuses a
 * box, the paper on that stack overstates it, and the only honest answer is a
 * replacement label. So a closed pallet's section offers one, an open pallet's
 * does not (nothing has been printed yet), and «Принято» clears one section at
 * a time rather than every pallet's news at once.
 *
 * A rejection is physical work: the box is on the pallet in the warehouse and
 * on some other pallet in the registry, so each row names its own box and
 * reason. «Принято» only clears the notice — it does not put the box back.
 */
@Composable
private fun RejectionsBlock(
    rejections: List<PalletMembershipEntity>,
    pallets: Map<String, PalletEntity>,
    cb: PalletsCallbacks,
) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Banner(
        pluralStringResource(R.plurals.pallets_rejected, rejections.size, rejections.size),
        Tone.Warn,
        Icons.Outlined.Warning,
    )
    Column(
        Modifier.fillMaxWidth().padding(horizontal = MarkiroSizes.sp4, vertical = MarkiroSizes.sp2),
        verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2),
    ) {
        // The query already orders by pallet, so grouping keeps that order and
        // the sections do not reshuffle under the operator's hand.
        rejections.groupBy { it.palletId }.forEach { (palletId, rows) ->
            val pallet = pallets[palletId]
            val closedSscc = pallet?.sscc?.takeIf { pallet.closedAt != null }
            Column(verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp1)) {
                Text(
                    when {
                        closedSscc != null -> stringResource(R.string.pallets_rejected_pallet, closedSscc.takeLast(TAIL))
                        // The pallet lookup itself failed (offline mirror miss,
                        // deleted row, etc.) -- naming it "open" would claim
                        // knowledge the section does not have.
                        pallet == null -> stringResource(R.string.pallets_rejection_pallet_unknown)
                        else -> stringResource(R.string.pallets_rejected_pallet_open)
                    },
                    style = t.strong,
                    color = c.fg1,
                )
                rows.forEach { row ->
                    Text(
                        stringResource(R.string.pallets_member_box, row.sscc.takeLast(TAIL)) + " — " + rejectionText(row),
                        style = t.caption,
                        color = c.fg2,
                    )
                }
                Spacer(Modifier.height(MarkiroSizes.sp1))
                SecondaryButton(stringResource(R.string.pallets_acknowledge), { cb.onAcknowledge(palletId) })
                // Only a closed pallet carries a printed label to replace.
                if (closedSscc != null) {
                    SecondaryButton(stringResource(R.string.pallets_reprint), { cb.onReprint(palletId) })
                }
            }
        }
    }
}

@Composable
private fun rejectionText(row: PalletMembershipEntity): String = when (row.reason) {
    // No winning SSCC means the box is on a pallet somebody else has not closed
    // yet, so there is no number to name -- «На паллете …» with an empty tail
    // read like a bug. Say what is actually known instead.
    "already_on_pallet" -> row.winningPalletSscc?.let { stringResource(R.string.pallets_reject_already_on_pallet, it.takeLast(TAIL)) }
        ?: stringResource(R.string.pallets_reject_already_on_open_pallet)
    "not_found" -> stringResource(R.string.pallets_reject_not_found)
    "not_closed" -> stringResource(R.string.pallets_reject_not_closed)
    "disassembled" -> stringResource(R.string.pallets_reject_disassembled)
    "pallet_closed" -> stringResource(R.string.pallets_reject_pallet_closed)
    "product_mismatch" -> stringResource(R.string.pallets_reject_product_mismatch)
    "subscription_read_only" -> stringResource(R.string.pallets_reject_read_only)
    else -> stringResource(R.string.pallets_reject_other)
}

/**
 * One box on the pallet.
 *
 * «Убрать» is offered only while the row is still pending: a `sent` row may
 * already be on the server, and only the server can take that one back.
 */
@Composable
private fun MemberRow(member: PalletMembershipEntity, onRemove: () -> Unit) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Row(
        Modifier.fillMaxWidth().heightIn(min = 56.dp).clip(RoundedCornerShape(MarkiroSizes.sp2))
            .background(c.surfacePanel).padding(horizontal = MarkiroSizes.sp3),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2),
    ) {
        Icon(Icons.Outlined.Inventory2, contentDescription = null, tint = c.fg3, modifier = Modifier.size(20.dp))
        Text(
            stringResource(R.string.pallets_member_box, member.sscc.takeLast(TAIL)),
            style = t.body,
            color = c.fg1,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        MarkiroChip(stringResource(statusLabel(member.status)), statusTone(member.status))
        if (member.status == MembershipStatus.PENDING) {
            IconAction(Icons.Outlined.Close, stringResource(R.string.pallets_remove), onClick = onRemove)
        }
    }
}

private fun statusLabel(status: String): Int = when (status) {
    MembershipStatus.SENT -> R.string.pallets_status_sent
    MembershipStatus.ACCEPTED -> R.string.pallets_status_accepted
    else -> R.string.pallets_status_pending
}

private fun statusTone(status: String): Tone = when (status) {
    MembershipStatus.ACCEPTED -> Tone.Ok
    else -> Tone.Neutral
}

private const val TAIL = 6
