package app.markiro.handheld.feature.hub

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.markiro.handheld.R
import app.markiro.handheld.core.design.PrimaryButton
import app.markiro.handheld.core.design.MarkiroSizes
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.design.Tone
import app.markiro.handheld.core.design.tone
import app.markiro.handheld.core.util.TimeText
import app.markiro.handheld.feature.shift.label
import app.markiro.handheld.feature.shift.ssccWarning
import java.text.NumberFormat

@Composable
internal fun ActiveShiftCard(active: HubActiveShift, onContinue: () -> Unit) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    val shift = active.shift
    val numbers = NumberFormat.getIntegerInstance(LocalConfiguration.current.locales[0])
    val plan = shift.plannedQty?.takeIf { it > 0 }
    val accepted = active.acceptedUnits
    val count = numbers.format(accepted) + (plan?.let { " / " + numbers.format(it) } ?: "")
    val product = shift.productPrintName?.takeIf { it.isNotBlank() }
        ?: shift.productName?.takeIf { it.isNotBlank() }
    val mode = stringResource(when {
        shift.setItemsJson != null -> R.string.set_title
        shift.mode == "aggregation" -> R.string.hub_active_shift_aggregation
        else -> R.string.shifts_mode_validation
    })
    val shape = RoundedCornerShape(MarkiroSizes.radiusCard)
    Column(
        Modifier.fillMaxWidth().clip(shape).background(c.surfaceCard).border(1.dp, c.line, shape).padding(MarkiroSizes.sp4),
        verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp4),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp1)) {
            Text(stringResource(R.string.hub_active_shift_title, shift.number), style = if (product == null) t.strong else t.caption, color = c.fg2)
            product?.let { Text(it, style = t.strong.copy(fontSize = 18.sp, lineHeight = 24.sp), color = c.fg1) }
            Text(listOfNotNull(shift.lineName?.takeIf { it.isNotBlank() }, mode).joinToString(" · "), style = t.caption, color = c.fg2)
        }
        // Said here, at entry, rather than by a refused close twenty scans in.
        shift.ssccWarning()?.let { warning ->
            Text(stringResource(warning.label()), style = t.body.copy(fontSize = 14.sp), color = c.tone(Tone.Warn).fg)
        }
        Column(verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2)) {
            Text(
                stringResource(if (active.shared) R.string.work_shift_total else R.string.hub_active_shift_local),
                style = t.caption, color = c.fg3,
            )
            FlowRow(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp1),
            ) {
                Text(count, modifier = Modifier.alignByBaseline(), style = t.code.copy(fontSize = 24.sp, lineHeight = 32.sp, fontWeight = FontWeight.SemiBold), color = c.fg1)
                if (plan != null) Text("${numbers.format(accepted.toLong() * 100 / plan)} %", modifier = Modifier.alignByBaseline(), style = t.caption.copy(fontSize = 14.sp), color = c.fg3)
            }
            if (plan != null) {
                val fraction = (accepted.toFloat() / plan).coerceIn(0f, 1f)
                Box(
                    Modifier.fillMaxWidth().height(4.dp).clip(RoundedCornerShape(999.dp)).background(c.surfacePanel)
                        .semantics { progressBarRangeInfo = ProgressBarRangeInfo(fraction, 0f..1f) },
                ) {
                    Box(Modifier.fillMaxWidth(fraction).height(4.dp).background(c.accent))
                }
            }
            if (active.shared) {
                // The figure is the shift-wide total, and offline it is the last one the host gave.
                active.staleAtMillis?.let { Text(stringResource(R.string.common_data_as_of, TimeText.hhmm(it)), style = t.caption, color = c.warnFg) }
                active.lineFull?.let {
                    Text(stringResource(R.string.work_shared_line_full, it.active, it.maxStations), style = t.body.copy(fontSize = 14.sp), color = c.tone(Tone.Warn).fg)
                }
            } else {
                active.summaryAt?.let {
                    Text(stringResource(R.string.common_data_as_of, TimeText.hhmm(it)), style = t.caption, color = c.fg3)
                }
            }
        }
        PrimaryButton(stringResource(R.string.hub_active_shift_continue), onContinue)
    }
}
