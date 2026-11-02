package app.markiro.handheld.core.design

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.material3.Shapes
import androidx.compose.foundation.shape.RoundedCornerShape
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
        primary = palette.fg1,
        onPrimary = palette.surfacePage,
        primaryContainer = palette.surfacePanel,
        onPrimaryContainer = palette.fg1,
        secondary = palette.fg1,
        onSecondary = palette.surfacePage,
        secondaryContainer = palette.surfacePanel,
        onSecondaryContainer = palette.fg1,
        tertiary = palette.fg1,
        onTertiary = palette.surfacePage,
        tertiaryContainer = palette.surfacePanel,
        onTertiaryContainer = palette.fg1,
        background = palette.surfacePage,
        onBackground = palette.fg1,
        surface = palette.surfaceCard,
        onSurface = palette.fg1,
        surfaceVariant = palette.surfacePanel,
        onSurfaceVariant = palette.fg2,
        outline = palette.lineControl,
        outlineVariant = palette.lineStrong,
        surfaceTint = palette.surfaceCard,
        surfaceBright = palette.surfaceCard,
        surfaceDim = palette.surfacePage,
        surfaceContainerLowest = palette.surfacePage,
        surfaceContainerLow = palette.surfaceCard,
        surfaceContainer = palette.surfaceCard,
        surfaceContainerHigh = palette.surfaceCard,
        surfaceContainerHighest = palette.surfacePanel,
        error = palette.errSolid,
        onError = palette.fgOnErr,
        errorContainer = palette.errBg,
        onErrorContainer = palette.errFg,
    )
    CompositionLocalProvider(LocalPalette provides palette, LocalTypography provides MarkiroTypography()) {
        MaterialTheme(
            colorScheme = scheme,
            typography = MarkiroMaterialTypography,
            shapes = Shapes(
                extraSmall = RoundedCornerShape(MarkiroSizes.radius),
                small = RoundedCornerShape(MarkiroSizes.radius),
                medium = RoundedCornerShape(MarkiroSizes.radius),
                large = RoundedCornerShape(MarkiroSizes.radiusCard),
                extraLarge = RoundedCornerShape(MarkiroSizes.radiusCard),
            ),
            content = content,
        )
    }
}

object MarkiroTheme {
    val colors: MarkiroPalette
        @Composable @ReadOnlyComposable get() = LocalPalette.current
    val type: MarkiroTypography
        @Composable @ReadOnlyComposable get() = LocalTypography.current
}
