package app.markiro.handheld.core.design

import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.compose.material3.Typography
import app.markiro.handheld.R

val PlexSans = FontFamily(
    Font(R.font.plex_sans_regular, FontWeight.Normal),
    Font(R.font.plex_sans_medium, FontWeight.Medium),
    Font(R.font.plex_sans_semibold, FontWeight.SemiBold),
    Font(R.font.plex_sans_bold, FontWeight.Bold),
)

val PlexMono = FontFamily(
    Font(R.font.plex_mono_regular, FontWeight.Normal),
    Font(R.font.plex_mono_medium, FontWeight.Medium),
    Font(R.font.plex_mono_semibold, FontWeight.SemiBold),
)

private const val TABULAR = "tnum"

/** Native Material fields, menus and dialogs use the same bundled face as custom controls. */
val MarkiroMaterialTypography = Typography().let { base ->
    base.copy(
        displayLarge = base.displayLarge.copy(fontFamily = PlexSans),
        displayMedium = base.displayMedium.copy(fontFamily = PlexSans),
        displaySmall = base.displaySmall.copy(fontFamily = PlexSans),
        headlineLarge = base.headlineLarge.copy(fontFamily = PlexSans),
        headlineMedium = base.headlineMedium.copy(fontFamily = PlexSans),
        headlineSmall = base.headlineSmall.copy(fontFamily = PlexSans),
        titleLarge = base.titleLarge.copy(fontFamily = PlexSans),
        titleMedium = base.titleMedium.copy(fontFamily = PlexSans),
        titleSmall = base.titleSmall.copy(fontFamily = PlexSans),
        bodyLarge = base.bodyLarge.copy(fontFamily = PlexSans),
        bodyMedium = base.bodyMedium.copy(fontFamily = PlexSans),
        bodySmall = base.bodySmall.copy(fontFamily = PlexSans),
        labelLarge = base.labelLarge.copy(fontFamily = PlexSans),
        labelMedium = base.labelMedium.copy(fontFamily = PlexSans),
        labelSmall = base.labelSmall.copy(fontFamily = PlexSans),
    )
}

/** The handheld ramp from brief 10; counters and codes are tabular mono. */
data class MarkiroTypography(
    val body: TextStyle = TextStyle(fontFamily = PlexSans, fontSize = 16.sp, lineHeight = 22.sp),
    val strong: TextStyle = TextStyle(fontFamily = PlexSans, fontSize = 18.sp, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold),
    val title: TextStyle = TextStyle(fontFamily = PlexSans, fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.Bold),
    val caption: TextStyle = TextStyle(fontFamily = PlexSans, fontSize = 13.sp, lineHeight = 18.sp),
    val label: TextStyle = TextStyle(fontFamily = PlexSans, fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.6.sp),
    val code: TextStyle = TextStyle(fontFamily = PlexMono, fontSize = 20.sp, lineHeight = 24.sp, fontWeight = FontWeight.Medium, fontFeatureSettings = TABULAR),
    val counter: TextStyle = TextStyle(fontFamily = PlexMono, fontSize = 40.sp, lineHeight = 44.sp, fontWeight = FontWeight.SemiBold, fontFeatureSettings = TABULAR),
    val counterLg: TextStyle = TextStyle(fontFamily = PlexMono, fontSize = 56.sp, lineHeight = 60.sp, fontWeight = FontWeight.SemiBold, fontFeatureSettings = TABULAR),
    val key: TextStyle = TextStyle(fontFamily = PlexMono, fontSize = 28.sp, lineHeight = 32.sp, fontWeight = FontWeight.Medium, fontFeatureSettings = TABULAR),
)
