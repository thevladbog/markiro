package app.markiro.handheld

import android.app.Activity
import androidx.activity.compose.BackHandler
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import app.markiro.handheld.core.design.FullScreenState
import app.markiro.handheld.core.design.StateAction

/** No task callbacks survive an actual process exit. An Activity recreation is insufficient. */
@Composable
fun DatasetResetScreen(ready: Boolean, failed: Boolean, retry: () -> Unit) {
    val context = LocalContext.current
    BackHandler { /* The generation cannot return to a cached work screen. */ }
    val close = StateAction(stringResource(R.string.host_dataset_reset_close)) {
        (context as? Activity)?.finishAndRemoveTask()
        android.os.Process.killProcess(android.os.Process.myPid())
    }
    FullScreenState(
        icon = Icons.Outlined.Refresh,
        title = stringResource(R.string.host_dataset_reset_title),
        text = stringResource(if (ready && !failed) R.string.host_dataset_reset_body else R.string.host_dataset_reset_failed),
        primary = if (ready && !failed) close else StateAction(stringResource(R.string.common_retry), retry),
        secondary = if (ready && failed) close else null,
    )
}
