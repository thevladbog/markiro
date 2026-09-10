package app.markiro.handheld.feature.inventory

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material.icons.outlined.WifiOff
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import app.markiro.handheld.R
import app.markiro.handheld.core.design.FullScreenState
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.design.StateAction
import app.markiro.handheld.core.design.Tone

@Composable
fun InventoryLeaveScreen(step: LeaveStep, onDone: () -> Unit, onBack: () -> Unit) {
    Column(Modifier.fillMaxSize().background(MarkiroTheme.colors.surfacePage)) {
        when (step) {
            is LeaveStep.Draining -> FullScreenState(
                Icons.Outlined.Sync,
                stringResource(R.string.inventory_leave_draining),
                stringResource(R.string.inventory_leave_draining_left, step.pending),
                tone = Tone.Info,
            )
            is LeaveStep.Offline -> FullScreenState(
                Icons.Outlined.WifiOff,
                stringResource(R.string.inventory_leave_offline_title),
                stringResource(R.string.inventory_leave_offline_text, step.pending),
                primary = StateAction(stringResource(R.string.inventory_to_hub), onDone),
                secondary = StateAction(stringResource(R.string.common_back), onBack),
                tone = Tone.Warn,
                primaryIsAccent = false,
            )
            LeaveStep.Failed -> FullScreenState(
                Icons.Outlined.ErrorOutline,
                stringResource(R.string.inventory_leave_failed),
                "",
                primary = StateAction(stringResource(R.string.common_back), onBack),
                tone = Tone.Err,
                primaryIsAccent = false,
            )
            LeaveStep.Left -> FullScreenState(
                Icons.Outlined.CheckCircle,
                stringResource(R.string.inventory_left_title),
                stringResource(R.string.inventory_left_text),
                primary = StateAction(stringResource(R.string.inventory_to_hub), onDone),
                tone = Tone.Ok,
            )
        }
    }
}
