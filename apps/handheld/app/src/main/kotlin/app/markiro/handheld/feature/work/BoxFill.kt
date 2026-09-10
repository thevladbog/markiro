package app.markiro.handheld.feature.work

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.markiro.handheld.core.design.MarkiroSizes
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.design.Tone
import app.markiro.handheld.core.design.tone
import kotlin.math.ceil
import kotlin.math.min
import kotlin.math.sqrt

/**
 * Above this many units the cells stop being countable at a glance on a 360 dp
 * screen, so the grid gives way to a large counter rather than pretending a
 * hundred dots can be read. Sixty is six rows of ten at the mockup's cell size.
 *
 * A judgement made without a device in hand; the spec lists it as an open point.
 */
const val GRID_MAX_CAPACITY = 60

fun showsGrid(capacity: Int): Boolean = capacity in 1..GRID_MAX_CAPACITY

/** Columns for a roughly square grid, capped at ten so cells stay wide enough to see. */
fun gridColumns(capacity: Int): Int =
    if (capacity <= 0) 1 else min(10, ceil(sqrt(capacity.toDouble())).toInt())

fun gridRows(capacity: Int): Int =
    if (capacity <= 0) 1 else ceil(capacity.toDouble() / gridColumns(capacity)).toInt()

/**
 * How full the open box is.
 *
 * The grid is the drawn form and the one an operator can read without counting.
 * The counter is what a capacity the grid cannot honestly show degrades to.
 */
@Composable
fun BoxFill(filled: Int, capacity: Int, modifier: Modifier = Modifier) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    BoxWithConstraints(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        if (!showsGrid(capacity)) {
            Text("$filled / $capacity", style = t.counterLg, color = c.fg1, textAlign = TextAlign.Center)
            return@BoxWithConstraints
        }
        val columns = gridColumns(capacity)
        val rows = gridRows(capacity)
        // The cell is sized from the space it is given rather than fixed, so the
        // grid reads as the box it stands for instead of a small patch in the
        // middle of an empty zone. The tighter of the two axes wins, so cells stay
        // square, and the cap stops a two-unit box from becoming two huge slabs.
        val cell = minOf(
            (maxWidth - GAP * (columns - 1)) / columns,
            (maxHeight - GAP * (rows - 1)) / rows,
            MAX_CELL,
        ).coerceAtLeast(MIN_CELL)
        Column(verticalArrangement = Arrangement.spacedBy(GAP)) {
            repeat(rows) { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(GAP)) {
                    repeat(columns) { column ->
                        val index = row * columns + column
                        if (index < capacity) Cell(index < filled, index == filled, cell)
                    }
                }
            }
        }
    }
}

private val GAP = 6.dp
private val MIN_CELL = 12.dp
private val MAX_CELL = 88.dp

/**
 * Filled, next, or empty.
 *
 * The next cell carries a border rather than only a colour, so an operator who
 * cannot tell the two apart still sees where the box is up to.
 */
@Composable
private fun Cell(filled: Boolean, next: Boolean, size: Dp) {
    val c = MarkiroTheme.colors
    val shape = RoundedCornerShape(size / 5)
    Box(
        Modifier
            .size(size)
            .background(if (filled) c.tone(Tone.Ok).solid else c.surfacePanel, shape)
            .then(if (next) Modifier.border(2.dp, c.accent, shape) else Modifier),
    )
}

/** «Короб 27 · 14 / 20» above the grid. */
@Composable
fun BoxHeader(text: String, modifier: Modifier = Modifier) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Text(
        text,
        style = t.strong.copy(fontSize = 18.sp),
        color = c.fg1,
        modifier = modifier.fillMaxWidth().padding(horizontal = MarkiroSizes.sp4),
        textAlign = TextAlign.Center,
    )
}
