package app.markiro.handheld.core.design

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.markiro.handheld.R

/** The existing splash mark, cropped to its artwork and using the current theme's foreground. */
@Composable
fun MarkiroLogo(modifier: Modifier = Modifier) {
    val c = MarkiroTheme.colors
    val description = stringResource(R.string.brand_markiro)
    Canvas(modifier.size(28.dp).semantics { contentDescription = description; role = Role.Image }) {
        val scale = minOf(size.width / 100f, size.height / 112f)
        val left = (size.width - 100f * scale) / 2f
        fun square(x: Float, y: Float, green: Boolean = false) {
            drawRect(if (green) c.accent else c.fg1, Offset(left + x * scale, y * scale), Size(24.8f * scale, 24.8f * scale))
        }
        for (x in listOf(0f, 74.4f)) for (y in listOf(0f, 37.2f, 74.4f)) square(x, y)
        square(37.2f, 24.8f)
        square(37.2f, 86.8f, green = true)
    }
}

@Composable
fun MarkiroBrand() {
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        MarkiroLogo()
        Text(stringResource(R.string.brand_markiro), style = MarkiroTheme.type.strong, color = MarkiroTheme.colors.fg1)
    }
}
