package app.markiro.handheld.feature.shift

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Factory
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material.icons.outlined.Report
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material.icons.outlined.SystemUpdate
import androidx.compose.material.icons.outlined.WifiOff
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import app.markiro.handheld.R
import app.markiro.handheld.core.design.AppBar
import app.markiro.handheld.core.design.FullScreenState
import app.markiro.handheld.core.design.StateAction
import app.markiro.handheld.core.design.Tone

/**
 * The full-screen states an entry can end in: confirming another line's
 * shift, entering, and the four refusals.
 *
 * One composable for the list and the hub's «Продолжить», because the two go
 * through the same `ShiftRepository.enter` and can be refused the same way --
 * a hub that skipped `enter` never showed these, and never refreshed the
 * bundle either.
 *
 * @param onRetry What «Повторить» on the unreachable state does: the list
 * refreshes, the hub tries the entry again.
 */
@Composable
fun ShiftDialogScreen(
    dialog: ShiftDialog,
    ownLineName: String?,
    onDismiss: () -> Unit,
    onRetry: () -> Unit,
    onConfirmOther: () -> Unit = {},
) {
    when (dialog) {
        is ShiftDialog.ConfirmOther -> {
            AppBar(stringResource(R.string.shifts_title), onDismiss)
            FullScreenState(
                Icons.Outlined.Factory,
                stringResource(R.string.shifts_join_other_title),
                stringResource(R.string.shifts_join_other_text, dialog.shift.number, dialog.lineName, ownLineName.orEmpty()),
                primary = StateAction(stringResource(R.string.shifts_enter), onConfirmOther),
                secondary = StateAction(stringResource(R.string.common_cancel), onDismiss),
            )
        }
        ShiftDialog.Entering -> {
            AppBar(stringResource(R.string.shifts_title))
            FullScreenState(Icons.Outlined.Sync, stringResource(R.string.shifts_entering), "", tone = Tone.Info)
        }
        ShiftDialog.UpdateRequired -> {
            AppBar(stringResource(R.string.shifts_title), onDismiss)
            FullScreenState(
                Icons.Outlined.SystemUpdate,
                stringResource(R.string.shifts_update_required_title),
                stringResource(R.string.shifts_update_required_text),
                primary = StateAction(stringResource(R.string.common_got_it), onDismiss),
                tone = Tone.Warn,
                primaryIsAccent = false,
            )
        }
        ShiftDialog.Closed -> {
            AppBar(stringResource(R.string.shifts_title), onDismiss)
            FullScreenState(
                Icons.Outlined.Factory,
                stringResource(R.string.shifts_closed_title),
                stringResource(R.string.shifts_closed_text),
                primary = StateAction(stringResource(R.string.common_got_it), onDismiss),
                primaryIsAccent = false,
            )
        }
        is ShiftDialog.Refused -> {
            AppBar(stringResource(R.string.shifts_title), onDismiss)
            // A refusal this build can name is said in words, with where to fix
            // it; anything else shows the server's own code for the office.
            val named = ssccRefusalLabel(dialog.code)
            FullScreenState(
                Icons.Outlined.Report,
                stringResource(R.string.shifts_refused_title),
                if (named != null) {
                    stringResource(named)
                } else {
                    stringResource(
                        R.string.shifts_refused_text,
                        stringResource(
                            when (dialog.step) {
                                EnterStep.ENTER -> R.string.shifts_refused_step_enter
                                EnterStep.BUNDLE -> R.string.shifts_refused_step_bundle
                            },
                        ),
                        dialog.status,
                        dialog.code ?: stringResource(R.string.shifts_refused_no_code),
                    )
                },
                primary = StateAction(stringResource(R.string.common_got_it), onDismiss),
                tone = Tone.Err,
                primaryIsAccent = false,
            )
        }
        ShiftDialog.BarcodeUnknown -> {
            AppBar(stringResource(R.string.shifts_title), onDismiss)
            FullScreenState(
                Icons.Outlined.QrCodeScanner,
                stringResource(R.string.shifts_barcode_unknown_title),
                stringResource(R.string.shifts_barcode_unknown_text),
                primary = StateAction(stringResource(R.string.common_got_it), onDismiss),
                tone = Tone.Warn,
                primaryIsAccent = false,
            )
        }
        ShiftDialog.Unavailable -> {
            AppBar(stringResource(R.string.shifts_title), onDismiss)
            FullScreenState(
                Icons.Outlined.WifiOff,
                stringResource(R.string.common_server_unavailable),
                stringResource(R.string.shifts_needs_network),
                primary = StateAction(stringResource(R.string.common_retry), onRetry),
                secondary = StateAction(stringResource(R.string.common_cancel), onDismiss),
                tone = Tone.Err,
            )
        }
    }
}
