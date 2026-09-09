package app.markiro.handheld.feature.hub

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.outlined.Factory
import androidx.compose.material.icons.outlined.Inventory2
import androidx.compose.material.icons.outlined.Print
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material.icons.outlined.Wifi
import androidx.compose.material.icons.outlined.WifiOff
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.markiro.handheld.core.design.Banner
import app.markiro.handheld.core.design.IconAction
import app.markiro.handheld.core.design.MarkiroSizes
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.design.StatusItem
import app.markiro.handheld.core.design.StatusStrip
import app.markiro.handheld.core.design.Tile
import app.markiro.handheld.core.design.Tone
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun HubScreen(state: HubUi, onTile: (HubTile) -> Unit, onSignOut: () -> Unit) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Column(Modifier.fillMaxSize().background(c.surfacePage)) {
        StatusStrip(
            listOf(
                if (state.reachable) StatusItem(Icons.Outlined.Wifi, "Сеть") else StatusItem(Icons.Outlined.WifiOff, "Офлайн", Tone.Warn),
                StatusItem(Icons.Outlined.Sync, "Очередь 0"),
                StatusItem(Icons.Outlined.Print, "Принтер"),
                StatusItem(Icons.Outlined.QrCodeScanner, state.scannerLabel.ifEmpty { "Сканер" }),
            ),
        )
        if (!state.reachable) Banner("Работаем офлайн", Tone.Warn, Icons.Outlined.WifiOff)
        Column(Modifier.padding(MarkiroSizes.sp4), verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3)) {
            Row(Modifier.fillMaxWidth().height(44.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(state.organization, style = t.caption, color = c.fg3)
                    Text(
                        listOfNotNull(state.operatorName.ifEmpty { null }, state.lineName).joinToString(" · "),
                        style = t.strong.copy(fontSize = 16.sp),
                        color = c.fg1,
                    )
                }
                IconAction(Icons.AutoMirrored.Outlined.Logout, "Выйти", onSignOut)
            }
            val stamp = state.countsAt?.takeIf { !state.reachable }
                ?.let { " · данные на " + SimpleDateFormat("HH:mm", Locale.forLanguageTag("ru")).format(Date(it)) }
                .orEmpty()
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3)) {
                Tile(Icons.Outlined.Factory, "Смена", shiftsLabel(state.shifts) + stamp, { onTile(HubTile.SHIFT) }, Modifier.weight(1f))
                Tile(Icons.Outlined.Inventory2, "Инвентаризация", inventoriesLabel(state.inventories), { onTile(HubTile.INVENTORY) }, Modifier.weight(1f))
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3)) {
                Tile(Icons.Outlined.QrCodeScanner, "Проверка кода", "нажмите триггер", { onTile(HubTile.CHECK) }, Modifier.weight(1f))
                Tile(Icons.Outlined.Settings, "Настройки", "принтер не настроен", { onTile(HubTile.SETTINGS) }, Modifier.weight(1f), statusTone = Tone.Warn)
            }
        }
    }
}

internal fun shiftsLabel(count: Int?): String = when (count) {
    null -> "нет данных"
    0 -> "смен нет"
    1 -> "1 доступна"
    else -> "$count доступны"
}

internal fun inventoriesLabel(count: Int?): String = when (count) {
    null -> "нет данных"
    0 -> "заданий нет"
    1 -> "1 задание"
    2, 3, 4 -> "$count задания"
    else -> "$count заданий"
}
