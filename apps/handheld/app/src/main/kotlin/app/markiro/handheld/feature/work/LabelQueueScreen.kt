package app.markiro.handheld.feature.work

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.sp
import app.markiro.handheld.R
import app.markiro.handheld.core.design.AppBar
import app.markiro.handheld.core.design.MarkiroSizes
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.design.MarkiroTextButton
import app.markiro.handheld.core.design.PrimaryButton
import app.markiro.handheld.core.design.SecondaryButton
import app.markiro.handheld.core.design.Tone
import app.markiro.handheld.core.design.tone
import app.markiro.handheld.core.util.Iso
import app.markiro.handheld.core.util.TimeText

data class LabelQueueCallbacks(
    val onBack: () -> Unit = {},
    val onPrintOne: (String) -> Unit = {},
    val onPrintAll: () -> Unit = {},
    val onResolveUnknown: (String) -> Unit = {},
)

/**
 * Labels owed on closed boxes.
 *
 * The queue belongs to the device rather than to a shift, so it survives
 * leaving and closing one: the boxes are already reported and identified, and
 * the physical label is a debt the operator can see and settle later.
 */
@Composable
fun LabelQueueScreen(state: LabelQueueUi, cb: LabelQueueCallbacks) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Column(Modifier.fillMaxSize().background(c.surfacePage)) {
        AppBar(stringResource(R.string.label_queue_title), onBack = cb.onBack)
        if (state.items.isEmpty()) {
            Text(
                stringResource(R.string.label_queue_empty),
                style = t.body,
                color = c.fg3,
                modifier = Modifier.padding(MarkiroSizes.sp4),
            )
            return@Column
        }
        LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2)) {
            items(state.items, key = { it.boxId }) { item ->
                Column(Modifier.fillMaxWidth().padding(horizontal = MarkiroSizes.sp4, vertical = MarkiroSizes.sp2)) {
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(item.sscc, style = t.code.copy(fontSize = 16.sp), color = c.fg1)
                        Text(
                            Iso.parse(item.closedAt)?.let { TimeText.hhmm(it) } ?: "",
                            style = t.caption,
                            color = c.fg3,
                        )
                    }
                    val tone = if (item.skippedByPrintAll) Tone.Warn else Tone.Err
                    Text(
                        stringResource(printReasonLabel(item.reason.orEmpty())),
                        style = t.caption,
                        color = c.tone(tone).fg,
                    )
                    if (item.skippedByPrintAll) {
                        Text(stringResource(R.string.label_queue_unknown_skipped), style = t.caption, color = c.fg3)
                        Row(horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2)) {
                            SecondaryButton(
                                stringResource(R.string.label_queue_resolve),
                                { cb.onResolveUnknown(item.boxId) },
                                enabled = !state.printing,
                            )
                            MarkiroTextButton(stringResource(R.string.label_queue_print_one), { cb.onPrintOne(item.boxId) })
                        }
                    } else {
                        MarkiroTextButton(stringResource(R.string.label_queue_print_one), { cb.onPrintOne(item.boxId) })
                    }
                }
            }
        }
        Column(Modifier.padding(MarkiroSizes.sp4)) {
            PrimaryButton(stringResource(R.string.label_queue_print_all), cb.onPrintAll, enabled = !state.printing)
        }
    }
}
