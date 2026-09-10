package app.markiro.handheld.feature.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Construction
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.markiro.handheld.core.design.AppBar
import app.markiro.handheld.core.design.FullScreenState
import app.markiro.handheld.core.design.MarkiroChip
import app.markiro.handheld.core.design.MarkiroSizes
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.design.PrimaryButton
import app.markiro.handheld.core.design.StateAction
import app.markiro.handheld.core.design.Tone
import app.markiro.handheld.core.scan.ScanEvent
import app.markiro.handheld.core.scan.ScanSourceKind
import app.markiro.handheld.core.scan.VendorProfiles
import app.markiro.handheld.core.storage.DeviceConfigEntity
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun SettingsScreen(
    state: SettingsUi,
    config: DeviceConfigEntity?,
    onBack: () -> Unit,
    onScanner: () -> Unit,
    onTheme: (ThemeMode) -> Unit,
    onLanguage: (String) -> Unit,
) {
    val c = MarkiroTheme.colors
    Column(Modifier.fillMaxSize().background(c.surfacePage)) {
        AppBar("Настройки", onBack)
        Column(Modifier.padding(horizontal = MarkiroSizes.sp4)) {
            SettingRow("Сканер", sourceLabel(state), onScanner)
            SettingRow("Язык", if (state.language == "en") "English" else "Русский") {
                onLanguage(if (state.language == "en") "ru" else "en")
            }
            SettingRow(
                "Тема",
                when (state.theme) {
                    ThemeMode.DARK -> "Тёмная"
                    ThemeMode.LIGHT -> "Светлая"
                    ThemeMode.SYSTEM -> "Как в системе"
                },
            ) { onTheme(ThemeMode.entries[(state.theme.ordinal + 1) % ThemeMode.entries.size]) }
            Text(
                "ОБ УСТРОЙСТВЕ",
                style = MarkiroTheme.type.label,
                color = c.fg3,
                modifier = Modifier.padding(top = MarkiroSizes.sp4, bottom = MarkiroSizes.sp2),
            )
            InfoRow("Имя", listOfNotNull(config?.deviceName, config?.lineName).joinToString(" · "))
            InfoRow("Сервер", config?.serverUrl.orEmpty().removePrefix("https://"))
            InfoRow("Версия", state.version)
            InfoRow(
                "Операторы",
                config?.rosterFetchedAt?.let { "обновлены " + SimpleDateFormat("dd.MM HH:mm", Locale.forLanguageTag("ru")).format(Date(it)) }
                    ?: "не загружены",
            )
            Text(
                "Отвязать устройство можно только из кабинета.",
                style = MarkiroTheme.type.caption,
                color = c.fg3,
                modifier = Modifier.padding(top = MarkiroSizes.sp3),
            )
        }
    }
}

private fun sourceLabel(state: SettingsUi): String = when (state.sourceKind) {
    ScanSourceKind.BUILTIN_INTENT -> "встроенный · " + VendorProfiles.byId(state.profileId).label.substringBefore(" ·")
    ScanSourceKind.KEYBOARD_WEDGE -> "клавиатурный wedge"
    ScanSourceKind.DEBUG -> "отладка"
}

@Composable
fun ScannerSettingsScreen(
    state: SettingsUi,
    onBack: () -> Unit,
    onSource: (ScanSourceKind) -> Unit,
    onProfile: (String) -> Unit,
    onDebugScan: (String) -> Unit,
) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Column(Modifier.fillMaxSize().background(c.surfacePage)) {
        AppBar("Сканер", onBack)
        Column(Modifier.padding(MarkiroSizes.sp4), verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2)) {
            Text("ИСТОЧНИК СКАНОВ", style = t.label, color = c.fg3)
            OptionRow("Встроенный сканер", VendorProfiles.byId(state.profileId).setupHint, state.sourceKind == ScanSourceKind.BUILTIN_INTENT) {
                onSource(ScanSourceKind.BUILTIN_INTENT)
            }
            OptionRow("Клавиатурный wedge", "универсальный запасной путь: сканер печатает код как клавиатура", state.sourceKind == ScanSourceKind.KEYBOARD_WEDGE) {
                onSource(ScanSourceKind.KEYBOARD_WEDGE)
            }
            if (state.sourceKind == ScanSourceKind.BUILTIN_INTENT) {
                Text("ПРОФИЛЬ ВЕНДОРА", style = t.label, color = c.fg3)
                VendorProfiles.ALL.forEach { profile ->
                    OptionRow(profile.label, "действие ${profile.action}", state.profileId == profile.id) { onProfile(profile.id) }
                }
            }
            Text("ТЕСТОВЫЙ СКАН", style = t.label, color = c.fg3)
            TestScan(state.lastScan)
            if (state.debugScanEnabled) {
                var text by remember { mutableStateOf("") }
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    label = { Text("Отладочный скан (только debug)") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                PrimaryButton("Отправить как скан", {
                    onDebugScan(text)
                    text = ""
                }, enabled = text.isNotEmpty())
            }
        }
    }
}

@Composable
private fun TestScan(event: ScanEvent?) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(MarkiroSizes.radius)).background(c.surfaceCard)
            .border(1.dp, c.line, RoundedCornerShape(MarkiroSizes.radius)).padding(MarkiroSizes.sp3),
        verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2),
    ) {
        if (event == null) {
            Text("Нажмите триггер — здесь появится сырая строка с разделителями GS.", style = t.caption, color = c.fg3)
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp1), verticalAlignment = Alignment.CenterVertically) {
                event.raw.split('\u001d').forEachIndexed { index, part ->
                    if (index > 0) MarkiroChip("GS", Tone.Info)
                    Text(part, style = t.code.copy(fontSize = 14.sp), color = c.fg1)
                }
            }
            Text(
                "${event.symbology ?: "символика неизвестна"} · источник ${event.source} · ${event.raw.length} симв.",
                style = t.caption,
                color = c.okFg,
            )
        }
    }
}

@Composable
fun ComingSoonScreen(title: String, onBack: () -> Unit) {
    val c = MarkiroTheme.colors
    Column(Modifier.fillMaxSize().background(c.surfacePage)) {
        AppBar(title, onBack)
        FullScreenState(
            Icons.Outlined.Construction,
            "В следующем срезе",
            "Этот раздел появится после того, как ТСД научится работать в смене.",
            primary = StateAction("Назад", onBack),
            primaryIsAccent = false,
        )
    }
}

@Composable
private fun SettingRow(label: String, value: String, onClick: () -> Unit) {
    val c = MarkiroTheme.colors
    Row(
        Modifier.fillMaxWidth().height(MarkiroSizes.controlRow).clickable(onClick = onClick),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = MarkiroTheme.type.body, color = c.fg1)
        Text(value, style = MarkiroTheme.type.caption.copy(fontSize = 15.sp), color = c.fg2)
    }
}

@Composable
private fun InfoRow(label: String, value: String) {
    val c = MarkiroTheme.colors
    Row(Modifier.fillMaxWidth().height(40.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = MarkiroTheme.type.body, color = c.fg1)
        Text(value, style = MarkiroTheme.type.caption.copy(fontSize = 15.sp), color = c.fg1)
    }
}

@Composable
private fun OptionRow(label: String, sub: String, selected: Boolean, onClick: () -> Unit) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    val shape = RoundedCornerShape(MarkiroSizes.radius)
    Row(
        Modifier.fillMaxWidth().clip(shape).background(c.surfaceCard).border(1.dp, if (selected) c.accent else c.line, shape)
            .clickable(onClick = onClick).padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3),
    ) {
        Box(
            Modifier.size(22.dp).clip(CircleShape).border(2.dp, if (selected) c.accent else c.lineStrong, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            if (selected) Box(Modifier.size(10.dp).clip(CircleShape).background(c.accent))
        }
        Column {
            Text(label, style = t.strong.copy(fontSize = 16.sp), color = c.fg1)
            Text(sub, style = t.caption, color = c.fg3)
        }
    }
}
