package app.markiro.handheld.feature.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Construction
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.markiro.handheld.R
import app.markiro.handheld.core.design.AppBar
import app.markiro.handheld.core.design.FullScreenState
import app.markiro.handheld.core.design.MarkiroChip
import app.markiro.handheld.core.design.MarkiroSizes
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.design.PrimaryButton
import app.markiro.handheld.core.design.ScreenColumn
import app.markiro.handheld.core.design.StateAction
import app.markiro.handheld.core.design.Tone
import app.markiro.handheld.core.scan.ScanEvent
import app.markiro.handheld.core.scan.ScanSourceKind
import app.markiro.handheld.core.scan.VendorProfiles
import app.markiro.handheld.core.signal.SignalKind
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.update.DownloadResult
import app.markiro.handheld.core.update.UpdateState
import app.markiro.handheld.core.util.TimeText

@Composable
fun SettingsScreen(
    state: SettingsUi,
    config: DeviceConfigEntity?,
    onBack: () -> Unit,
    onScanner: () -> Unit,
    onPrinter: () -> Unit = {},
    onTheme: (ThemeMode) -> Unit,
    onLanguage: (String) -> Unit,
    onToggleSound: () -> Unit = {},
    onVolume: (Float) -> Unit = {},
    onToggleVibration: () -> Unit = {},
    onTest: (SignalKind) -> Unit = {},
    onCheckUpdate: () -> Unit = {},
    onInstallUpdate: () -> Unit = {},
) {
    val c = MarkiroTheme.colors
    Column(Modifier.fillMaxSize().background(c.surfacePage).verticalScroll(rememberScrollState())) {
        AppBar(stringResource(R.string.settings_title), onBack)
        Column(Modifier.padding(horizontal = MarkiroSizes.sp4)) {
            SettingRow(stringResource(R.string.settings_scanner), sourceLabel(state), onScanner)
            SettingRow(
                stringResource(R.string.printer_title),
                state.printerLabel ?: stringResource(R.string.printer_none),
                onPrinter,
            )
            SettingRow(stringResource(R.string.settings_language), if (state.language == "en") "English" else "Русский") {
                onLanguage(if (state.language == "en") "ru" else "en")
            }
            SettingRow(
                stringResource(R.string.settings_theme),
                when (state.theme) {
                    ThemeMode.DARK -> stringResource(R.string.theme_dark)
                    ThemeMode.LIGHT -> stringResource(R.string.theme_light)
                    ThemeMode.SYSTEM -> stringResource(R.string.theme_system)
                },
            ) { onTheme(ThemeMode.entries[(state.theme.ordinal + 1) % ThemeMode.entries.size]) }
            Text(
                stringResource(R.string.settings_signals),
                style = MarkiroTheme.type.label,
                color = c.fg3,
                modifier = Modifier.padding(top = MarkiroSizes.sp4, bottom = MarkiroSizes.sp2),
            )
            SettingRow(
                stringResource(R.string.settings_sound),
                stringResource(if (state.soundMuted) R.string.settings_off else R.string.settings_on),
                onToggleSound,
            )
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3)) {
                Text(stringResource(R.string.settings_volume), style = MarkiroTheme.type.body, color = c.fg1)
                Slider(value = state.soundVolume, onValueChange = onVolume, enabled = !state.soundMuted, modifier = Modifier.weight(1f))
            }
            SettingRow(
                stringResource(R.string.settings_vibration),
                stringResource(if (state.vibrationEnabled) R.string.settings_on else R.string.settings_off),
                onToggleVibration,
            )
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2)) {
                TestButton(stringResource(R.string.settings_test_ok), Modifier.weight(1f)) { onTest(SignalKind.OK) }
                TestButton(stringResource(R.string.settings_test_duplicate), Modifier.weight(1f)) { onTest(SignalKind.DUPLICATE) }
                TestButton(stringResource(R.string.settings_test_error), Modifier.weight(1f)) { onTest(SignalKind.ERROR) }
            }
            Text(
                stringResource(R.string.settings_about),
                style = MarkiroTheme.type.label,
                color = c.fg3,
                modifier = Modifier.padding(top = MarkiroSizes.sp4, bottom = MarkiroSizes.sp2),
            )
            InfoRow(stringResource(R.string.settings_name), listOfNotNull(config?.deviceName, config?.lineName).joinToString(" · "))
            InfoRow(stringResource(R.string.settings_server), config?.serverUrl.orEmpty().removePrefix("https://"))
            InfoRow(stringResource(R.string.settings_version), state.version)
            // A row, not a banner: the terminal is offline most of a shift, so
            // this answers only when an operator asks.
            SettingRow(stringResource(R.string.settings_update), updateLabel(state), onCheckUpdate)
            // Offered only here, never from the work screen: an install restarts
            // the app, and a line in the middle of a box should not meet it.
            if (state.update is UpdateState.Available) {
                SettingRow(
                    stringResource(R.string.settings_update_install),
                    installLabel(state),
                    onInstallUpdate,
                )
            }
            InfoRow(stringResource(R.string.settings_vendor), stringResource(R.string.settings_vendor_value))
            InfoRow(
                stringResource(R.string.settings_sync),
                state.lastSyncAt?.let { stringResource(R.string.settings_sync_value, state.queue, TimeText.hhmm(it)) }
                    ?: stringResource(R.string.settings_sync_never, state.queue),
            )
            InfoRow(stringResource(R.string.settings_install_id), state.installId.takeLast(8))
            InfoRow(
                stringResource(R.string.settings_operators),
                config?.rosterFetchedAt?.let { stringResource(R.string.settings_operators_updated, TimeText.ddmmHhmm(it)) }
                    ?: stringResource(R.string.settings_operators_missing),
            )
            Text(
                stringResource(R.string.settings_unbind_note),
                style = MarkiroTheme.type.caption,
                color = c.fg3,
                modifier = Modifier.padding(top = MarkiroSizes.sp3),
            )
        }
    }
}

@Composable
private fun installLabel(state: SettingsUi): String = when (val install = state.install) {
    null -> ""
    InstallStep.Downloading -> stringResource(R.string.settings_update_downloading)
    InstallStep.QueueNotEmpty -> stringResource(R.string.settings_update_queue)
    is InstallStep.Failed -> stringResource(
        when (install.failure) {
            DownloadResult.Failure.CORRUPT -> R.string.settings_update_failed_corrupt
            DownloadResult.Failure.NO_SPACE -> R.string.settings_update_failed_space
            DownloadResult.Failure.REFUSED -> R.string.settings_update_refused
            DownloadResult.Failure.UNREACHABLE -> R.string.settings_update_unreachable
        },
    )
}

/** «Не знаю» is a first-class answer here, and it says which kind of «не знаю». */
@Composable
private fun updateLabel(state: SettingsUi): String = when (val update = state.update) {
    null -> stringResource(R.string.settings_update_check)
    UpdateState.UpToDate -> stringResource(R.string.settings_update_current)
    is UpdateState.Available -> stringResource(R.string.settings_update_available, update.manifest.versionName)
    is UpdateState.Unknown -> stringResource(
        when (update.reason) {
            UpdateState.Reason.UNREACHABLE -> R.string.settings_update_unreachable
            UpdateState.Reason.REFUSED -> R.string.settings_update_refused
            UpdateState.Reason.MALFORMED -> R.string.settings_update_malformed
        },
    )
}

@Composable
private fun sourceLabel(state: SettingsUi): String = when (state.sourceKind) {
    ScanSourceKind.BUILTIN_INTENT ->
        stringResource(R.string.settings_source_builtin, VendorProfiles.byId(state.profileId).label.substringBefore(" ·"))
    ScanSourceKind.KEYBOARD_WEDGE -> stringResource(R.string.settings_source_wedge)
    ScanSourceKind.DEBUG -> stringResource(R.string.settings_source_debug)
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
    val current = VendorProfiles.byId(state.profileId)
    Column(Modifier.fillMaxSize().background(c.surfacePage)) {
        AppBar(stringResource(R.string.scanner_title), onBack)
        ScreenColumn(padding = PaddingValues(MarkiroSizes.sp4), verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2)) {
            Text(stringResource(R.string.scanner_sources), style = t.label, color = c.fg3)
            OptionRow(
                stringResource(R.string.scanner_builtin_title),
                stringResource(current.setupHintRes, current.action),
                state.sourceKind == ScanSourceKind.BUILTIN_INTENT,
            ) { onSource(ScanSourceKind.BUILTIN_INTENT) }
            OptionRow(
                stringResource(R.string.scanner_wedge_title),
                stringResource(R.string.scanner_wedge_hint),
                state.sourceKind == ScanSourceKind.KEYBOARD_WEDGE,
            ) { onSource(ScanSourceKind.KEYBOARD_WEDGE) }
            if (state.sourceKind == ScanSourceKind.BUILTIN_INTENT) {
                Text(stringResource(R.string.scanner_profiles), style = t.label, color = c.fg3)
                VendorProfiles.ALL.forEach { profile ->
                    OptionRow(profile.label, stringResource(R.string.scanner_action, profile.action), state.profileId == profile.id) {
                        onProfile(profile.id)
                    }
                }
            }
            Text(stringResource(R.string.scanner_test), style = t.label, color = c.fg3)
            TestScan(state.lastScan)
            if (state.debugScanEnabled) {
                var text by remember { mutableStateOf("") }
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    label = { Text(stringResource(R.string.scanner_debug_field)) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                PrimaryButton(stringResource(R.string.scanner_debug_send), {
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
            Text(stringResource(R.string.scanner_test_hint), style = t.caption, color = c.fg3)
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp1), verticalAlignment = Alignment.CenterVertically) {
                event.raw.split('\u001d').forEachIndexed { index, part ->
                    if (index > 0) MarkiroChip("GS", Tone.Info)
                    Text(part, style = t.code.copy(fontSize = 14.sp), color = c.fg1)
                }
            }
            Text(
                stringResource(
                    R.string.scanner_test_meta,
                    event.symbology ?: stringResource(R.string.scanner_symbology_unknown),
                    event.source,
                    event.raw.length,
                ),
                style = t.caption,
                color = c.okFg,
            )
        }
    }
}

@Composable
private fun TestButton(label: String, modifier: Modifier, onClick: () -> Unit) {
    val c = MarkiroTheme.colors
    val shape = RoundedCornerShape(MarkiroSizes.radius)
    Box(
        modifier.height(MarkiroSizes.controlIcon).clip(shape).background(c.surfaceCard).border(1.dp, c.lineStrong, shape).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Text(label, style = MarkiroTheme.type.body, color = c.fg1) }
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
