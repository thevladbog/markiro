package app.markiro.handheld.feature.work

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import app.markiro.handheld.R
import app.markiro.handheld.core.design.MarkiroSizes
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.util.TimeText
import app.markiro.handheld.feature.shift.SharedStrip

/**
 * The lines under the counters of a shift several devices work (plan 2b): how many devices are working it and, while the host's figures are the
 * last known ones, the time they are from. The counters themselves are the work screen's own two cells, relabelled by the same `strip`.
 */
@Composable
fun SharedShiftCaption(strip: SharedStrip, modifier: Modifier = Modifier) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Column(modifier.fillMaxWidth().padding(horizontal = MarkiroSizes.sp4)) {
        Text(stringResource(R.string.work_shared_devices, strip.active, strip.maxStations), style = t.caption, color = c.fg3)
        strip.staleAtMillis?.let { Text(stringResource(R.string.common_data_as_of, TimeText.hhmm(it)), style = t.caption, color = c.warnFg) }
    }
}
