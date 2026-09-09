package app.markiro.handheld.core.design

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf

private val LocalPalette = staticCompositionLocalOf { MarkiroColors.Dark }
private val LocalTypography = staticCompositionLocalOf { MarkiroTypography() }

@Composable
fun MarkiroTheme(dark: Boolean = true, content: @Composable () -> Unit) {
    val palette = if (dark) MarkiroColors.Dark else MarkiroColors.Light
    val scheme = (if (dark) darkColorScheme() else lightColorScheme()).copy(
        primary = palette.accent,
        onPrimary = palette.fgOnAccent,
        background = palette.surfacePage,
        onBackground = palette.fg1,
        surface = palette.surfaceCard,
        onSurface = palette.fg1,
        surfaceVariant = palette.surfacePanel,
        onSurfaceVariant = palette.fg2,
        outline = palette.line,
        outlineVariant = palette.lineStrong,
        error = palette.errSolid,
        onError = palette.fgOnErr,
    )
    CompositionLocalProvider(LocalPalette provides palette, LocalTypography provides MarkiroTypography()) {
        MaterialTheme(colorScheme = scheme, content = content)
    }
}

object MarkiroTheme {
    val colors: MarkiroPalette
        @Composable @ReadOnlyComposable get() = LocalPalette.current
    val type: MarkiroTypography
        @Composable @ReadOnlyComposable get() = LocalTypography.current
}
