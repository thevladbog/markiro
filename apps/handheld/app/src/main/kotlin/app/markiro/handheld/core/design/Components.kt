package app.markiro.handheld.core.design

import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Backspace
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.markiro.handheld.R

data class StatusItem(val icon: ImageVector, val label: String, val tone: Tone = Tone.Neutral)
data class StateAction(val label: String, val onClick: () -> Unit)

@Composable
fun StatusStrip(items: List<StatusItem>, modifier: Modifier = Modifier) {
    val c = MarkiroTheme.colors
    Row(
        modifier = modifier.fillMaxWidth().height(MarkiroSizes.statusStrip).background(c.surfacePanel)
            .padding(horizontal = MarkiroSizes.sp4),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        items.forEach { item ->
            val color = if (item.tone == Tone.Neutral) c.fg2 else c.tone(item.tone).fg
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp1)) {
                Icon(item.icon, contentDescription = null, tint = color, modifier = Modifier.size(16.dp))
                Text(item.label, style = MarkiroTheme.type.caption, color = color)
            }
        }
    }
}

@Composable
fun AppBar(title: String, onBack: (() -> Unit)? = null, actions: @Composable RowScope.() -> Unit = {}) {
    val c = MarkiroTheme.colors
    Row(
        modifier = Modifier.fillMaxWidth().height(MarkiroSizes.appBar).background(c.surfacePage)
            .padding(start = if (onBack == null) MarkiroSizes.sp4 else MarkiroSizes.sp1, end = MarkiroSizes.sp1),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (onBack != null) IconAction(Icons.AutoMirrored.Outlined.ArrowBack, stringResource(R.string.common_back), onBack)
        Text(
            title,
            style = MarkiroTheme.type.title.copy(fontSize = 20.sp, lineHeight = 26.sp),
            color = c.fg1,
            modifier = Modifier.weight(1f),
        )
        actions()
    }
}

@Composable
fun IconAction(icon: ImageVector, description: String, onClick: () -> Unit) {
    Box(
        modifier = Modifier.size(MarkiroSizes.controlIcon).clip(CircleShape).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Icon(icon, contentDescription = description, tint = MarkiroTheme.colors.fg1, modifier = Modifier.size(24.dp)) }
}

@Composable
private fun ButtonShell(
    height: Dp,
    background: Color,
    border: Color?,
    enabled: Boolean,
    onClick: () -> Unit,
    content: @Composable RowScope.() -> Unit,
) {
    val shape = RoundedCornerShape(MarkiroSizes.radius)
    Row(
        modifier = Modifier.fillMaxWidth().height(height).clip(shape)
            .background(if (enabled) background else MarkiroTheme.colors.surfacePanel)
            .then(if (border != null) Modifier.border(1.dp, border, shape) else Modifier)
            .clickable(enabled = enabled, onClick = onClick),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
        content = content,
    )
}

@Composable
fun PrimaryButton(label: String, onClick: () -> Unit, enabled: Boolean = true, icon: ImageVector? = null) {
    val c = MarkiroTheme.colors
    ButtonShell(MarkiroSizes.controlPrimary, c.accent, null, enabled, onClick) {
        if (icon != null) {
            Icon(icon, contentDescription = null, tint = c.fgOnAccent, modifier = Modifier.size(26.dp))
            Spacer(Modifier.size(MarkiroSizes.sp2))
        }
        Text(label, style = MarkiroTheme.type.strong, color = if (enabled) c.fgOnAccent else c.fgDisabled)
    }
}

@Composable
fun SecondaryButton(label: String, onClick: () -> Unit, enabled: Boolean = true) {
    val c = MarkiroTheme.colors
    ButtonShell(MarkiroSizes.controlRow, c.surfaceCard, c.lineStrong, enabled, onClick) {
        Text(label, style = MarkiroTheme.type.strong, color = if (enabled) c.fg1 else c.fgDisabled)
    }
}

@Composable
fun DestructiveButton(label: String, onClick: () -> Unit) {
    val c = MarkiroTheme.colors
    ButtonShell(MarkiroSizes.controlPrimary, c.errSolid, null, true, onClick) {
        Text(label, style = MarkiroTheme.type.strong, color = c.fgOnErr)
    }
}

@Composable
fun MarkiroTextButton(label: String, onClick: () -> Unit, tone: Tone = Tone.Accent) {
    val color = MarkiroTheme.colors.tone(tone).fg
    Row(
        modifier = Modifier.fillMaxWidth().height(MarkiroSizes.controlIcon).clickable(onClick = onClick),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) { Text(label, style = MarkiroTheme.type.body.copy(fontWeight = FontWeight.SemiBold), color = color) }
}

@Composable
fun Keypad(onDigit: (Char) -> Unit, onBackspace: () -> Unit, onConfirm: () -> Unit, confirmEnabled: Boolean) {
    val backspaceLabel = stringResource(R.string.common_backspace)
    Column(verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2), modifier = Modifier.fillMaxWidth()) {
        listOf("123", "456", "789").forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2), modifier = Modifier.fillMaxWidth()) {
                row.forEach { digit -> Key(Modifier.weight(1f), onClick = { onDigit(digit) }) { KeyLabel(digit.toString()) } }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2), modifier = Modifier.fillMaxWidth()) {
            Key(Modifier.weight(1f).semantics { contentDescription = backspaceLabel }, onClick = onBackspace) {
                Icon(Icons.Outlined.Backspace, contentDescription = null, tint = MarkiroTheme.colors.fg1, modifier = Modifier.size(26.dp))
            }
            Key(Modifier.weight(1f), onClick = { onDigit('0') }) { KeyLabel("0") }
            Key(Modifier.weight(1f), onClick = onConfirm, accent = true, enabled = confirmEnabled) {
                Text("OK", style = MarkiroTheme.type.strong.copy(fontSize = 20.sp), color = MarkiroTheme.colors.fgOnAccent)
            }
        }
    }
}

@Composable
private fun KeyLabel(text: String) = Text(text, style = MarkiroTheme.type.key, color = MarkiroTheme.colors.fg1)

@Composable
private fun Key(modifier: Modifier, onClick: () -> Unit, accent: Boolean = false, enabled: Boolean = true, content: @Composable () -> Unit) {
    val c = MarkiroTheme.colors
    val shape = RoundedCornerShape(MarkiroSizes.radius)
    Box(
        modifier = modifier.height(MarkiroSizes.key).clip(shape)
            .background(if (accent) (if (enabled) c.accent else c.surfacePanel) else c.surfaceCard)
            .then(if (accent) Modifier else Modifier.border(1.dp, c.line, shape))
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { content() }
}

@Composable
fun PinDots(total: Int, filled: Int) {
    val c = MarkiroTheme.colors
    Row(horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3), verticalAlignment = Alignment.CenterVertically) {
        repeat(total) { index ->
            Box(Modifier.size(14.dp).clip(CircleShape).background(if (index < filled) c.fg1 else c.lineStrong))
        }
    }
}

@Composable
fun Tile(icon: ImageVector, label: String, status: String, onClick: () -> Unit, modifier: Modifier = Modifier, statusTone: Tone = Tone.Neutral) {
    val c = MarkiroTheme.colors
    val shape = RoundedCornerShape(MarkiroSizes.radius)
    Column(
        // Minimum height from the brief; a two-line status (offline timestamp) grows the tile instead of clipping.
        modifier = modifier.heightIn(min = 116.dp).clip(shape).background(c.surfaceCard).border(1.dp, c.line, shape)
            .clickable(onClick = onClick).padding(14.dp),
        verticalArrangement = Arrangement.Bottom,
    ) {
        Icon(icon, contentDescription = null, tint = c.fg1, modifier = Modifier.size(28.dp))
        Spacer(Modifier.height(MarkiroSizes.sp2))
        Text(label, style = MarkiroTheme.type.strong.copy(fontSize = 16.sp), color = c.fg1)
        Text(
            status,
            style = MarkiroTheme.type.caption,
            color = if (statusTone == Tone.Neutral) c.fg3 else c.tone(statusTone).fg,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
fun MarkiroChip(text: String, tone: Tone = Tone.Neutral) {
    val t = MarkiroTheme.colors.tone(tone)
    Box(Modifier.clip(RoundedCornerShape(999.dp)).background(t.bg).padding(horizontal = 10.dp, vertical = MarkiroSizes.sp1)) {
        Text(text, style = MarkiroTheme.type.caption.copy(fontWeight = FontWeight.Medium), color = t.fg)
    }
}

@Composable
fun Banner(text: String, tone: Tone, icon: ImageVector) {
    val t = MarkiroTheme.colors.tone(tone)
    Row(
        modifier = Modifier.fillMaxWidth().background(t.bg).padding(horizontal = MarkiroSizes.sp4, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(icon, contentDescription = null, tint = t.fg, modifier = Modifier.size(20.dp))
        Text(text, style = MarkiroTheme.type.body.copy(fontSize = 15.sp, fontWeight = FontWeight.Medium), color = t.fg)
    }
}

@Composable
fun FullScreenState(
    icon: ImageVector,
    title: String,
    text: String,
    primary: StateAction? = null,
    secondary: StateAction? = null,
    tone: Tone = Tone.Neutral,
    primaryIsAccent: Boolean = true,
    scrollable: Boolean = false,
) {
    val c = MarkiroTheme.colors
    Column(
        modifier = Modifier.fillMaxSize().then(if (scrollable) Modifier.verticalScroll(rememberScrollState()) else Modifier).padding(MarkiroSizes.sp6),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(icon, contentDescription = null, tint = if (tone == Tone.Neutral) c.fg3 else c.tone(tone).fg, modifier = Modifier.size(48.dp))
        Spacer(Modifier.height(MarkiroSizes.sp3))
        Text(title, style = MarkiroTheme.type.title, color = c.fg1, textAlign = TextAlign.Center)
        Spacer(Modifier.height(MarkiroSizes.sp3))
        Text(text, style = MarkiroTheme.type.body, color = c.fg2, textAlign = TextAlign.Center)
        if (primary != null) {
            Spacer(Modifier.height(MarkiroSizes.sp6))
            if (primaryIsAccent) PrimaryButton(primary.label, primary.onClick) else SecondaryButton(primary.label, primary.onClick)
        }
        if (secondary != null) {
            Spacer(Modifier.height(MarkiroSizes.sp2))
            MarkiroTextButton(secondary.label, secondary.onClick)
        }
    }
}
