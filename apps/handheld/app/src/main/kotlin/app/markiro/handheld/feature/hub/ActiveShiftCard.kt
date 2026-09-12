package app.markiro.handheld.feature.hub

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.markiro.handheld.R
import app.markiro.handheld.core.design.MarkiroSizes
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.util.TimeText
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
    val title = listOfNotNull(stringResource(R.string.hub_active_shift_title, shift.number), product).joinToString(" · ")
    val mode = stringResource(if (shift.mode == "aggregation") R.string.hub_active_shift_aggregation else R.string.shifts_mode_validation)
    val shape = RoundedCornerShape(MarkiroSizes.radius)
    Column(
        Modifier.fillMaxWidth().clip(shape).background(c.surfaceCard).border(1.dp, c.lineStrong, shape)
            .clickable(role = Role.Button, onClick = onContinue),
    ) {
        Box(Modifier.fillMaxWidth().height(4.dp).background(c.accent))
        Column(Modifier.padding(MarkiroSizes.sp4), verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3)) {
            Text(stringResource(R.string.hub_active_shift), style = t.label, color = c.accent)
            Text(title, style = t.strong, color = c.fg1)
            Text(listOfNotNull(shift.lineName?.takeIf { it.isNotBlank() }, mode).joinToString(" · "), style = t.body.copy(fontSize = 14.sp), color = c.fg2)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2), verticalAlignment = Alignment.Bottom) {
                Text(count, modifier = Modifier.weight(1f), style = t.code.copy(fontWeight = FontWeight.SemiBold), color = c.fg1)
                if (plan != null) Text("${numbers.format(accepted.toLong() * 100 / plan)} %", style = t.caption.copy(fontSize = 14.sp), color = c.fg3)
            }
            if (plan != null) {
                val fraction = (accepted.toFloat() / plan).coerceIn(0f, 1f)
                Box(
                    Modifier.fillMaxWidth().height(6.dp).clip(RoundedCornerShape(999.dp)).background(c.surfacePanel)
                        .semantics { progressBarRangeInfo = ProgressBarRangeInfo(fraction, 0f..1f) },
                ) {
                    Box(Modifier.fillMaxWidth(fraction).height(6.dp).background(c.accent))
                }
            }
            Text(
                active.summaryAt?.let { stringResource(R.string.common_data_as_of, TimeText.hhmm(it)) }
                    ?: stringResource(R.string.hub_active_shift_local),
                style = t.caption, color = c.fg3,
            )
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.hub_active_shift_continue), modifier = Modifier.weight(1f), style = t.strong.copy(fontSize = 16.sp), color = c.accent)
                Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = null, tint = c.accent, modifier = Modifier.size(22.dp))
            }
        }
    }
}
