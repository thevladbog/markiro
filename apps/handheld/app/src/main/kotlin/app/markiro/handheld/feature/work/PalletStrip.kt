package app.markiro.handheld.feature.work

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.sp
import app.markiro.handheld.R
import app.markiro.handheld.core.design.MarkiroSizes
import app.markiro.handheld.core.design.MarkiroTheme

/**
 * «3 / 12 коробов» beneath `hh/BoxFill` -- drawn only for a shift with pallets
 * enabled (06d, design brief 10 §"Work screen -- aggregation and box close").
 *
 * Deliberately no grid of its own: the box grid above is already the screen's
 * main zone, and a second grid for something as coarse as boxes-per-pallet
 * would compete with it rather than support it. A plain counter line, the way
 * the grid itself degrades to one past `GRID_MAX_CAPACITY`.
 */
@Composable
fun PalletStrip(boxCount: Int, capacity: Int, modifier: Modifier = Modifier) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Text(
        stringResource(R.string.pallet_strip, boxCount, capacity),
        style = t.strong.copy(fontSize = 16.sp),
        color = c.fg2,
        textAlign = TextAlign.Center,
        modifier = modifier.fillMaxWidth().padding(top = MarkiroSizes.sp1, bottom = MarkiroSizes.sp2),
    )
}
