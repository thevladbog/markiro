package app.markiro.handheld.core.design

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.markiro.handheld.R

/** Routine connectivity occupies one header target; details and recovery remain one tap away. */
@Composable
fun HeaderStatus(items: List<StatusItem>, tone: Tone, pending: Int = 0, actions: List<StateAction> = emptyList()) {
    val c = MarkiroTheme.colors
    val title = stringResource(R.string.header_status_title)
    val summary = items.joinToString(". ") { it.label }
    var open by remember { mutableStateOf(false) }
    Row(
        Modifier.heightIn(min = 48.dp).widthIn(min = 48.dp).clip(RoundedCornerShape(MarkiroSizes.radius))
            .clickable(role = Role.Button) { open = true }
            .semantics {
                contentDescription = title
                stateDescription = summary
                if (tone == Tone.Err) liveRegion = LiveRegionMode.Assertive
                else if (tone == Tone.Warn) liveRegion = LiveRegionMode.Polite
            }
            .padding(8.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp, Alignment.CenterHorizontally),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (tone == Tone.Ok && pending == 0) {
            Box(Modifier.size(12.dp).clip(CircleShape).background(c.okFg))
        } else {
            val icon = when (tone) {
                Tone.Err -> Icons.Outlined.ErrorOutline
                Tone.Warn -> items.firstOrNull()?.icon ?: Icons.Outlined.Sync
                else -> Icons.Outlined.Sync
            }
            Icon(icon, null, tint = c.tone(tone).fg, modifier = Modifier.size(20.dp))
            if (pending > 0) Text(pending.toString(), style = MarkiroTheme.type.code.copy(fontSize = 13.sp, lineHeight = 18.sp), color = c.tone(tone).fg)
        }
    }
    if (open) AlertDialog(
        onDismissRequest = { open = false },
        containerColor = c.surfaceCard,
        title = { Text(title, style = MarkiroTheme.type.title, color = c.fg1) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                items.forEach { item ->
                    val color = c.tone(item.tone).fg
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(item.icon, null, tint = color, modifier = Modifier.size(20.dp))
                        Text(item.label, style = MarkiroTheme.type.body, color = color, modifier = Modifier.weight(1f))
                    }
                }
                actions.forEach { action -> SecondaryButton(action.label, { open = false; action.onClick() }) }
            }
        },
        confirmButton = { TextButton(onClick = { open = false }) { Text(stringResource(R.string.header_status_done)) } },
    )
}
