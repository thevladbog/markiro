package app.markiro.handheld.core.design

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/** One entry per token in packages/ui/src/tokens.css; values copied verbatim. */
data class MarkiroPalette(
    val surfacePage: Color,
    val surfaceCard: Color,
    val surfacePanel: Color,
    val surfaceOverlay: Color,
    val fg1: Color,
    val fg2: Color,
    val fg3: Color,
    val fgDisabled: Color,
    val line: Color,
    val lineStrong: Color,
    val accent: Color,
    val fgOnAccent: Color,
    val okFg: Color,
    val okBg: Color,
    val okBorder: Color,
    val okSolid: Color,
    val fgOnOk: Color,
    val errFg: Color,
    val errBg: Color,
    val errBorder: Color,
    val errSolid: Color,
    val fgOnErr: Color,
    val warnFg: Color,
    val warnBg: Color,
    val warnBorder: Color,
    val warnSolid: Color,
    val fgOnWarn: Color,
    val infoFg: Color,
    val infoBg: Color,
    val infoBorder: Color,
    val infoSolid: Color,
    val fgOnInfo: Color,
    val focusRing: Color,
)

object MarkiroColors {
    val Dark = MarkiroPalette(
        surfacePage = Color(0xFF131216),
        surfaceCard = Color(0xFF1C1B21),
        surfacePanel = Color(0xFF232228),
        surfaceOverlay = Color(0xA6000000),
        fg1 = Color(0xFFFAFAF8),
        fg2 = Color(0xFFB6B3AB),
        fg3 = Color(0xFF8E8B83),
        fgDisabled = Color(0xFF5B5952),
        line = Color(0xFF2E2D33),
        lineStrong = Color(0xFF45444B),
        accent = Color(0xFF3DDC7A),
        fgOnAccent = Color(0xFF0B2A17),
        okFg = Color(0xFF3DDC7A),
        okBg = Color(0xFF142E1D),
        okBorder = Color(0xFF1F4A2E),
        okSolid = Color(0xFF3DDC7A),
        fgOnOk = Color(0xFF0B2A17),
        errFg = Color(0xFFFF6B5E),
        errBg = Color(0xFF391A16),
        errBorder = Color(0xFF5C2A24),
        errSolid = Color(0xFFFF6B5E),
        fgOnErr = Color(0xFF391A16),
        warnFg = Color(0xFFFFB84D),
        warnBg = Color(0xFF33250E),
        warnBorder = Color(0xFF543E19),
        warnSolid = Color(0xFFFFB84D),
        fgOnWarn = Color(0xFF33250E),
        infoFg = Color(0xFF6DB2FF),
        infoBg = Color(0xFF152740),
        infoBorder = Color(0xFF234066),
        infoSolid = Color(0xFF6DB2FF),
        fgOnInfo = Color(0xFF152740),
        focusRing = Color(0xFF6DB2FF),
    )

    val Light = MarkiroPalette(
        surfacePage = Color(0xFFFAFAF8),
        surfaceCard = Color(0xFFFFFFFF),
        surfacePanel = Color(0xFFF0EFEA),
        surfaceOverlay = Color(0x8C17161A),
        fg1 = Color(0xFF17161A),
        fg2 = Color(0xFF45433E),
        fg3 = Color(0xFF6B6862),
        fgDisabled = Color(0xFFA5A29A),
        line = Color(0xFFE0DED7),
        lineStrong = Color(0xFFC9C6BD),
        accent = Color(0xFF0FAF56),
        fgOnAccent = Color(0xFF0B2A17),
        okFg = Color(0xFF116335),
        okBg = Color(0xFFE7F6EC),
        okBorder = Color(0xFFCFE8D8),
        okSolid = Color(0xFF0FAF56),
        fgOnOk = Color(0xFF0B2A17),
        errFg = Color(0xFFA1231A),
        errBg = Color(0xFFFDEAE7),
        errBorder = Color(0xFFF2D4D0),
        errSolid = Color(0xFFC0392B),
        fgOnErr = Color(0xFFFFFFFF),
        warnFg = Color(0xFF8A4C07),
        warnBg = Color(0xFFFDF0DC),
        warnBorder = Color(0xFFEFDFBE),
        warnSolid = Color(0xFFDD9420),
        fgOnWarn = Color(0xFF33250E),
        infoFg = Color(0xFF1A4F9C),
        infoBg = Color(0xFFE5EFFC),
        infoBorder = Color(0xFFD2E2F7),
        infoSolid = Color(0xFF2E6FD0),
        fgOnInfo = Color(0xFFFFFFFF),
        focusRing = Color(0xFF1A4F9C),
    )
}

object MarkiroSizes {
    val controlPrimary = 64.dp
    val controlRow = 56.dp
    val controlIcon = 48.dp
    val key = 72.dp
    val statusStrip = 32.dp
    val appBar = 56.dp
    val radius = 8.dp
    val sp1 = 4.dp
    val sp2 = 8.dp
    val sp3 = 12.dp
    val sp4 = 16.dp
    val sp5 = 20.dp
    val sp6 = 24.dp
}

enum class Tone { Neutral, Ok, Err, Warn, Info, Accent }

/** Foreground / background / border for a tone, so screens never pick raw colors. */
data class ToneColors(val fg: Color, val bg: Color, val border: Color, val solid: Color, val onSolid: Color)

fun MarkiroPalette.tone(tone: Tone): ToneColors = when (tone) {
    Tone.Neutral -> ToneColors(fg2, surfacePanel, line, surfacePanel, fg1)
    Tone.Ok -> ToneColors(okFg, okBg, okBorder, okSolid, fgOnOk)
    Tone.Err -> ToneColors(errFg, errBg, errBorder, errSolid, fgOnErr)
    Tone.Warn -> ToneColors(warnFg, warnBg, warnBorder, warnSolid, fgOnWarn)
    Tone.Info -> ToneColors(infoFg, infoBg, infoBorder, infoSolid, fgOnInfo)
    Tone.Accent -> ToneColors(accent, surfaceCard, accent, accent, fgOnAccent)
}
