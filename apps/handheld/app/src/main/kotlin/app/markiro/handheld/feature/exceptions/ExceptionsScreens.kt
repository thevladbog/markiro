package app.markiro.handheld.feature.exceptions

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.outlined.Undo
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.DeleteSweep
import androidx.compose.material.icons.outlined.Inventory2
import androidx.compose.material.icons.outlined.Print
import androidx.compose.material.icons.outlined.Warning
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.markiro.handheld.R
import app.markiro.handheld.core.design.AppBar
import app.markiro.handheld.core.design.FullScreenState
import app.markiro.handheld.core.design.MarkiroSizes
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.design.StateAction
import app.markiro.handheld.core.design.Tone

data class ExceptionsCallbacks(
    val onBack: () -> Unit = {},
    val onDisassemble: () -> Unit = {},
    val onClear: () -> Unit = {},
    val onReprint: () -> Unit = {},
    val onUndo: () -> Unit = {},
    val onConfirm: () -> Unit = {},
    val onDismiss: () -> Unit = {},
)

/**
 * The four corrections, and the two that confirm on a named target.
 *
 * Disassemble and reprint identify their box by scanning its label, which is
 * what the operator is holding. The other two cannot: an open box has no label
 * and no SSCC yet, and an undone code may be buried in the carton or damaged --
 * often the very reason it is being undone. Those confirm on a screen that
 * names the target instead.
 */
@Composable
fun ExceptionsScreen(state: ExceptionsUi, cb: ExceptionsCallbacks) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    when (val step = state.step) {
        ExceptionsStep.ConfirmUndo -> {
            val target = state.undoTarget
            FullScreenState(
                icon = Icons.AutoMirrored.Outlined.Undo,
                title = stringResource(R.string.exceptions_confirm_undo_title),
                text = stringResource(
                    R.string.exceptions_confirm_undo_body,
                    target?.codeTail.orEmpty(),
                    target?.scannedAt.orEmpty(),
                ),
                primary = StateAction(stringResource(R.string.exceptions_confirm), cb.onConfirm),
                secondary = StateAction(stringResource(R.string.common_cancel), cb.onDismiss),
                tone = Tone.Warn,
            )
            return
        }
        ExceptionsStep.ConfirmClear -> {
            FullScreenState(
                icon = Icons.Outlined.DeleteSweep,
                title = stringResource(R.string.exceptions_confirm_clear_title),
                text = stringResource(
                    R.string.exceptions_confirm_clear_body,
                    state.openBoxOrdinal,
                    state.openBoxCount,
                ),
                primary = StateAction(stringResource(R.string.exceptions_confirm), cb.onConfirm),
                secondary = StateAction(stringResource(R.string.common_cancel), cb.onDismiss),
                tone = Tone.Warn,
            )
            return
        }
        is ExceptionsStep.Done -> {
            FullScreenState(
                icon = Icons.Outlined.CheckCircle,
                title = stringResource(step.message),
                text = "",
                primary = StateAction(stringResource(R.string.common_cancel), cb.onDismiss),
                tone = Tone.Ok,
            )
            return
        }
        is ExceptionsStep.Refused -> {
            FullScreenState(
                icon = Icons.Outlined.Warning,
                title = stringResource(step.message),
                text = "",
                primary = StateAction(stringResource(R.string.common_cancel), cb.onDismiss),
                tone = Tone.Warn,
            )
            return
        }
        ExceptionsStep.List -> Unit
    }
    Column(Modifier.fillMaxSize().background(c.surfacePage)) {
        AppBar(stringResource(R.string.exceptions_title), onBack = cb.onBack)
        Column(
            Modifier.padding(MarkiroSizes.sp4),
            verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2),
        ) {
            ActionRow(
                icon = Icons.Outlined.Inventory2,
                label = stringResource(R.string.exceptions_disassemble),
                enabled = state.reprintableCount > 0,
                unavailable = stringResource(R.string.exceptions_no_closed_boxes),
                onClick = cb.onDisassemble,
            )
            ActionRow(
                icon = Icons.Outlined.DeleteSweep,
                label = stringResource(R.string.exceptions_clear),
                // Units, not merely a box row: the row is created lazily by the
                // first scan, so a freshly opened box has none and clearing it
                // would be a no-op the engine refuses anyway.
                enabled = state.openBoxCount > 0,
                unavailable = stringResource(R.string.exceptions_no_units),
                onClick = cb.onClear,
            )
            ActionRow(
                icon = Icons.Outlined.Print,
                label = stringResource(R.string.exceptions_reprint),
                enabled = state.reprintableCount > 0,
                unavailable = stringResource(R.string.exceptions_no_closed_boxes),
                onClick = cb.onReprint,
            )
            ActionRow(
                icon = Icons.AutoMirrored.Outlined.Undo,
                label = stringResource(R.string.exceptions_undo),
                enabled = state.canUndo,
                // True whether the box is missing, empty, or simply has no scan
                // left to take back -- the operator only needs to know there is
                // nothing to undo.
                unavailable = stringResource(R.string.exceptions_no_last_scan),
                onClick = cb.onUndo,
            )
            state.undoTarget?.let { target ->
                Text(
                    stringResource(R.string.exceptions_last_scan, target.codeTail, target.scannedAt),
                    style = t.caption,
                    color = c.fg3,
                    modifier = Modifier.padding(top = MarkiroSizes.sp2),
                )
            }
        }
    }
}

/**
 * One 64 dp action row, shared with the disassemble and reprint flows.
 *
 * An unavailable row carries its reason in words underneath. A greyed control
 * with no explanation reads as a broken screen, and an operator who cannot tell
 * the two apart stops trusting either.
 */
@Composable
fun ActionRow(
    icon: ImageVector,
    label: String,
    enabled: Boolean,
    unavailable: String,
    onClick: () -> Unit,
) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    val shape = RoundedCornerShape(MarkiroSizes.radius)
    Column {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 64.dp).clip(shape).background(c.surfaceCard)
                .border(1.dp, c.line, shape)
                .clickable(enabled = enabled, onClick = onClick)
                .padding(horizontal = MarkiroSizes.sp3),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3)) {
                Icon(icon, contentDescription = null, tint = if (enabled) c.fg1 else c.fg3, modifier = Modifier.size(24.dp))
                Text(label, style = t.strong.copy(fontSize = 16.sp), color = if (enabled) c.fg1 else c.fg3)
            }
            Icon(
                Icons.AutoMirrored.Outlined.KeyboardArrowRight,
                contentDescription = null,
                tint = c.fg3,
                modifier = Modifier.size(20.dp),
            )
        }
        if (!enabled) {
            Text(
                unavailable,
                style = t.caption,
                color = c.fg3,
                modifier = Modifier.padding(start = MarkiroSizes.sp3, top = 2.dp),
            )
        }
    }
}
