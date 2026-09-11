package app.markiro.handheld.feature.printer

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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.unit.dp
import app.markiro.handheld.R
import app.markiro.handheld.core.design.AppBar
import app.markiro.handheld.core.design.MarkiroSizes
import app.markiro.handheld.core.design.MarkiroTextButton
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.design.PrimaryButton
import app.markiro.handheld.core.design.SecondaryButton
import app.markiro.handheld.core.design.Tone
import app.markiro.handheld.core.design.tone
import app.markiro.handheld.core.label.PrinterLanguage
import app.markiro.handheld.core.label.TestLabel
import app.markiro.handheld.core.print.DiscoveredPrinter
import app.markiro.handheld.core.print.NotReadyReason
import app.markiro.handheld.core.print.PRINTER_TIMEOUT_MS
import app.markiro.handheld.core.print.PrinterEntity

data class PrinterListCallbacks(
    val onBack: () -> Unit = {},
    val onSelect: (String) -> Unit = {},
    val onTest: () -> Unit = {},
    val onAdd: () -> Unit = {},
)

data class AddPrinterCallbacks(
    val onBack: () -> Unit = {},
    val onTransport: (TransportKind) -> Unit = {},
    val onHost: (String) -> Unit = {},
    val onPort: (String) -> Unit = {},
    val onLanguage: (PrinterLanguage) -> Unit = {},
    val onDpi: (Int) -> Unit = {},
    val onCheck: () -> Unit = {},
    val onBluetooth: () -> Unit = {},
)

data class BluetoothPairCallbacks(
    val onBack: () -> Unit = {},
    val onGrant: () -> Unit = {},
    val onSearchAgain: () -> Unit = {},
    val onPick: (DiscoveredPrinter) -> Unit = {},
)

data class TestPrintCallbacks(
    val onBack: () -> Unit = {},
    val onConfirm: () -> Unit = {},
    val onRetry: () -> Unit = {},
)

data class PrinterErrorCallbacks(
    val onBack: () -> Unit = {},
    val onRetry: () -> Unit = {},
    val onEdit: () -> Unit = {},
)

@Composable
fun PrinterListScreen(state: PrinterUi, cb: PrinterListCallbacks) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Column(Modifier.fillMaxSize().background(c.surfacePage).verticalScroll(rememberScrollState())) {
        AppBar(stringResource(R.string.printer_title), cb.onBack)
        Column(
            Modifier.padding(horizontal = MarkiroSizes.sp4),
            verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2),
        ) {
            state.selected?.let { printer ->
                Text(stringResource(R.string.printer_selected), style = t.label, color = c.fg3)
                PrinterRow(printer, selected = true, onClick = {})
            }
            val others = state.printers.filterNot { it.selected }
            if (others.isNotEmpty()) {
                Text(stringResource(R.string.printer_available), style = t.label, color = c.fg3)
                others.forEach { printer ->
                    PrinterRow(printer, selected = false, onClick = { cb.onSelect(printer.id) })
                }
            }
            state.selected?.let { printer ->
                SettingRow(
                    stringResource(R.string.printer_language_and_dpi),
                    stringResource(R.string.printer_language_dpi_value, printer.language.uppercase(), printer.dpi),
                ) {}
                PrimaryButton(stringResource(R.string.printer_test), cb.onTest)
            }
            MarkiroTextButton(stringResource(R.string.printer_add_by_address), cb.onAdd)
        }
    }
}

@Composable
private fun PrinterRow(printer: PrinterEntity, selected: Boolean, onClick: () -> Unit) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    val shape = RoundedCornerShape(MarkiroSizes.radius)
    Row(
        Modifier.fillMaxWidth().clip(shape).background(c.surfaceCard)
            .border(1.dp, if (selected) c.accent else c.line, shape)
            .clickable(onClick = onClick).padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3),
    ) {
        Box(
            Modifier.size(22.dp).clip(CircleShape).border(2.dp, if (selected) c.accent else c.lineStrong, CircleShape),
            contentAlignment = Alignment.Center,
        ) { if (selected) Box(Modifier.size(10.dp).clip(CircleShape).background(c.accent)) }
        Column(Modifier.weight(1f)) {
            Text(printer.name, style = t.body, color = c.fg1)
            Text(
                listOfNotNull(
                    if (printer.transport == "bluetooth") "Bluetooth" else "Wi-Fi",
                    printer.address,
                    printer.lastStatus,
                ).joinToString(" · "),
                style = t.caption,
                color = c.fg2,
            )
        }
    }
}

@Composable
fun AddPrinterScreen(form: AddPrinterForm, cb: AddPrinterCallbacks) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Column(Modifier.fillMaxSize().background(c.surfacePage).verticalScroll(rememberScrollState())) {
        AppBar(stringResource(R.string.printer_add_title), cb.onBack)
        Column(
            Modifier.padding(horizontal = MarkiroSizes.sp4),
            verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2),
        ) {
            ChoiceRow(
                stringResource(R.string.printer_transport_wifi),
                stringResource(R.string.printer_transport_wifi_hint),
                form.transport == TransportKind.WIFI,
            ) { cb.onTransport(TransportKind.WIFI) }
            ChoiceRow(
                stringResource(R.string.printer_transport_bluetooth),
                stringResource(R.string.printer_transport_bluetooth_hint),
                form.transport == TransportKind.BLUETOOTH,
            ) { cb.onBluetooth() }

            if (form.transport == TransportKind.WIFI) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3)) {
                    Field(stringResource(R.string.printer_host), form.host, Modifier.weight(2f), cb.onHost)
                    Field(stringResource(R.string.printer_port), form.port, Modifier.weight(1f), cb.onPort, digitsOnly = true)
                }
            }
            Text(stringResource(R.string.printer_language), style = t.label, color = c.fg3)
            Segmented(
                listOf("ZPL" to PrinterLanguage.ZPL, "TSPL" to PrinterLanguage.TSPL),
                form.language,
                cb.onLanguage,
            )
            Text(stringResource(R.string.printer_dpi), style = t.label, color = c.fg3)
            Segmented(listOf("203 dpi" to 203, "300 dpi" to 300), form.dpi, cb.onDpi)

            form.error?.let { reason ->
                Text(stringResource(reasonLabel(reason)), style = t.strong, color = c.tone(Tone.Err).fg)
            }
            PrimaryButton(stringResource(R.string.printer_check), cb.onCheck, enabled = !form.checking)
        }
    }
}

@Composable
fun BluetoothPairScreen(state: PrinterUi, cb: BluetoothPairCallbacks) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Column(Modifier.fillMaxSize().background(c.surfacePage).verticalScroll(rememberScrollState())) {
        AppBar(stringResource(R.string.printer_bluetooth_title), cb.onBack)
        Column(
            Modifier.padding(horizontal = MarkiroSizes.sp4),
            verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2),
        ) {
            if (state.permissionNeeded) {
                Text(stringResource(R.string.printer_bluetooth_permission), style = t.body, color = c.fg2)
                PrimaryButton(stringResource(R.string.printer_bluetooth_grant), cb.onGrant)
                return@Column
            }
            Text(stringResource(R.string.printer_bluetooth_hint), style = t.caption, color = c.fg2)
            Text(stringResource(R.string.printer_bluetooth_found), style = t.label, color = c.fg3)
            if (state.paired.isEmpty()) {
                Text(stringResource(R.string.printer_bluetooth_empty), style = t.body, color = c.fg2)
            }
            state.paired.forEach { device ->
                Row(
                    Modifier.fillMaxWidth().height(MarkiroSizes.controlRow),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3),
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(device.name, style = t.body, color = c.fg1)
                        Text(device.address, style = t.caption, color = c.fg2)
                    }
                    Box(Modifier.clickable { cb.onPick(device) }.padding(MarkiroSizes.sp2)) {
                        Text(stringResource(R.string.printer_bluetooth_pick), style = t.body, color = c.accent)
                    }
                }
            }
            SecondaryButton(stringResource(R.string.printer_bluetooth_search_again), cb.onSearchAgain)
        }
    }
}

@Composable
fun TestPrintScreen(step: TestPrintStep, language: PrinterLanguage, dpi: Int, cb: TestPrintCallbacks) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Column(Modifier.fillMaxSize().background(c.surfacePage).verticalScroll(rememberScrollState())) {
        AppBar(stringResource(R.string.printer_test_title), cb.onBack)
        Column(
            Modifier.padding(horizontal = MarkiroSizes.sp4),
            verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3),
        ) {
            when (step) {
                is TestPrintStep.Idle, is TestPrintStep.Sending ->
                    Text(stringResource(R.string.printer_test_sending), style = t.body, color = c.fg2)

                is TestPrintStep.Sent -> {
                    Banner(stringResource(R.string.printer_test_sent), step.printerLabel, Tone.Ok)
                    LabelPreview(TestLabel.spec(), TestLabel.data())
                    Text(stringResource(R.string.printer_preview_barcode_note), style = t.caption, color = c.fg3)
                    Text(stringResource(R.string.printer_test_question), style = t.body, color = c.fg1)
                    PrimaryButton(stringResource(R.string.printer_test_yes), cb.onConfirm)
                    SecondaryButton(stringResource(R.string.printer_test_no), cb.onRetry)
                }

                is TestPrintStep.Unknown -> {
                    Banner(stringResource(R.string.printer_test_unknown_title), step.cause, Tone.Warn)
                    Text(stringResource(R.string.printer_test_unknown_body), style = t.body, color = c.fg2)
                    // Confirming is the primary action on purpose: it is the cheap, safe one, and a
                    // second send is the deliberate one.
                    PrimaryButton(stringResource(R.string.printer_test_unknown_confirm), cb.onConfirm)
                    SecondaryButton(stringResource(R.string.printer_test_unknown_again), cb.onRetry)
                }

                is TestPrintStep.Failed -> {
                    Banner(
                        stringResource(R.string.printer_test_failed),
                        stringResource(reasonLabel(step.reason)),
                        Tone.Err,
                    )
                    SecondaryButton(stringResource(R.string.printer_check_again), cb.onRetry)
                }
            }
            Text("${language.wire.uppercase()} · $dpi dpi", style = t.caption, color = c.fg3)
        }
    }
}

@Composable
fun PrinterErrorScreen(address: String, cb: PrinterErrorCallbacks) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Column(Modifier.fillMaxSize().background(c.surfacePage)) {
        AppBar(stringResource(R.string.printer_add_title), cb.onBack)
        Column(
            Modifier.padding(MarkiroSizes.sp4),
            verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3),
        ) {
            Text(stringResource(R.string.printer_unreachable_title), style = t.title, color = c.tone(Tone.Err).fg)
            Text(
                stringResource(R.string.printer_unreachable_body, address, PRINTER_TIMEOUT_MS / 1000),
                style = t.body,
                color = c.fg2,
            )
            PrimaryButton(stringResource(R.string.printer_check_again), cb.onRetry)
            MarkiroTextButton(stringResource(R.string.printer_edit_address), cb.onEdit)
        }
    }
}

private fun reasonLabel(reason: NotReadyReason): Int = when (reason) {
    NotReadyReason.NO_PAPER -> R.string.printer_no_paper
    NotReadyReason.HEAD_OPEN -> R.string.printer_head_open
    NotReadyReason.UNREACHABLE -> R.string.printer_unreachable_title
    NotReadyReason.OTHER -> R.string.printer_not_ready
}

@Composable
private fun Banner(title: String, detail: String, tone: Tone) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    val colors = c.tone(tone)
    val shape = RoundedCornerShape(MarkiroSizes.radius)
    Column(
        Modifier.fillMaxWidth().clip(shape).background(colors.bg).border(1.dp, colors.border, shape)
            .padding(MarkiroSizes.sp3),
        verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp1),
    ) {
        Text(title, style = t.strong, color = colors.fg)
        Text(detail, style = t.caption, color = c.fg2)
    }
}

@Composable
private fun ChoiceRow(label: String, sub: String, selected: Boolean, onClick: () -> Unit) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    val shape = RoundedCornerShape(MarkiroSizes.radius)
    Row(
        Modifier.fillMaxWidth().clip(shape).background(c.surfaceCard)
            .border(1.dp, if (selected) c.accent else c.line, shape)
            .clickable(onClick = onClick).padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3),
    ) {
        Box(
            Modifier.size(22.dp).clip(CircleShape).border(2.dp, if (selected) c.accent else c.lineStrong, CircleShape),
            contentAlignment = Alignment.Center,
        ) { if (selected) Box(Modifier.size(10.dp).clip(CircleShape).background(c.accent)) }
        Column {
            Text(label, style = t.body, color = c.fg1)
            Text(sub, style = t.caption, color = c.fg2)
        }
    }
}

@Composable
private fun <T> Segmented(options: List<Pair<String, T>>, current: T, onPick: (T) -> Unit) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    val shape = RoundedCornerShape(MarkiroSizes.radius)
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2)) {
        options.forEach { (label, value) ->
            val active = value == current
            Box(
                Modifier.weight(1f).height(MarkiroSizes.controlRow).clip(shape)
                    .background(if (active) c.surfacePanel else c.surfaceCard)
                    .border(1.dp, if (active) c.accent else c.line, shape)
                    .clickable { onPick(value) },
                contentAlignment = Alignment.Center,
            ) { Text(label, style = t.body, color = if (active) c.fg1 else c.fg2) }
        }
    }
}

@Composable
private fun Field(
    label: String,
    value: String,
    modifier: Modifier,
    onChange: (String) -> Unit,
    digitsOnly: Boolean = false,
) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    val shape = RoundedCornerShape(MarkiroSizes.radius)
    Column(modifier, verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp1)) {
        Text(label, style = t.label, color = c.fg3)
        Box(
            Modifier.fillMaxWidth().height(MarkiroSizes.controlRow).clip(shape).background(c.surfaceCard)
                .border(1.dp, c.line, shape).padding(horizontal = 14.dp),
            contentAlignment = Alignment.CenterStart,
        ) {
            BasicTextField(
                value = value,
                onValueChange = onChange,
                singleLine = true,
                textStyle = t.body.copy(color = c.fg1),
                cursorBrush = SolidColor(c.accent),
                keyboardOptions = KeyboardOptions(
                    keyboardType = if (digitsOnly) KeyboardType.Number else KeyboardType.Text,
                    imeAction = ImeAction.Done,
                ),
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

/** Mirrors the row shape used by the settings screen; kept here so the two files stay independent. */
@Composable
private fun SettingRow(label: String, value: String, onClick: () -> Unit) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Row(
        Modifier.fillMaxWidth().height(MarkiroSizes.controlRow).clickable(onClick = onClick),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = t.body, color = c.fg1)
        Text(value, style = t.caption, color = c.fg2)
    }
}
