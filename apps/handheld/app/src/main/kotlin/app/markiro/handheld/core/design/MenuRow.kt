package app.markiro.handheld.core.design

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
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
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** A compact navigation target that grows with translated or enlarged text. */
@Composable
fun MenuRow(
    icon: ImageVector?,
    label: String,
    status: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    statusTone: Tone = Tone.Neutral,
    enabled: Boolean = true,
) {
    val c = MarkiroTheme.colors
    Row(
        modifier.fillMaxWidth().heightIn(min = 56.dp).clip(RoundedCornerShape(MarkiroSizes.radius))
            .background(c.surfaceCard).clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) Icon(icon, null, tint = if (enabled) c.fg1 else c.fgDisabled, modifier = Modifier.size(24.dp))
        Column(Modifier.weight(1f)) {
            Text(label, style = MarkiroTheme.type.strong.copy(fontSize = 17.sp), color = if (enabled) c.fg1 else c.fgDisabled)
            if (status.isNotEmpty()) Text(status, style = MarkiroTheme.type.caption, color = c.tone(statusTone).fg)
        }
        Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null, tint = c.fg2, modifier = Modifier.size(20.dp))
    }
}
