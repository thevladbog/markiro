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
import androidx.compose.foundation.layout.heightIn
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
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
import app.markiro.handheld.core.print.PrintPurpose
import app.markiro.handheld.core.print.PrinterRouting

data class PrinterListCallbacks(
    val onBack: () -> Unit = {},
    val onSelect: (String) -> Unit = {},
    val onTest: (String) -> Unit = {},
    val onAssignments: () -> Unit = {},
    val onEdit: (String) -> Unit = {},
    val onAdd: () -> Unit = {},
)

data class AddPrinterCallbacks(
    val onName: (String) -> Unit = {},
    val onRemove: () -> Unit = {},
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

private fun printerStatusLabel(status: String?): Int? = when (status) {
    "no_paper" -> R.string.printer_no_paper
    "head_open" -> R.string.printer_head_open
    "unreachable" -> R.string.print_reason_unreachable
    "other" -> R.string.printer_not_ready
    "unknown" -> R.string.printer_test_unknown_title
    else -> null
}

fun purposeLabel(purpose: PrintPurpose): Int = when (purpose) {
    PrintPurpose.BOX -> R.string.printer_purpose_box
    PrintPurpose.DUPLICATE -> R.string.printer_purpose_duplicate
    PrintPurpose.PALLET -> R.string.printer_purpose_pallet
}

@Composable
fun PrinterListScreen(state: PrinterUi, cb: PrinterListCallbacks) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    val routing = PrinterRouting(state.printers, state.assignments)
    Column(Modifier.fillMaxSize().background(c.surfacePage)) {
        AppBar(stringResource(R.string.printers_title), cb.onBack)
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = MarkiroSizes.sp4),
            verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2)) {
            Text(stringResource(R.string.printer_profiles_hint), style = t.caption, color = c.fg2)
            if (state.printers.isEmpty()) Text(stringResource(R.string.printer_profiles_empty), style = t.body, color = c.fg2)
            state.printers.forEach { printer ->
                Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(MarkiroSizes.radius))
                    .background(c.surfaceCard).border(1.dp, c.line, RoundedCornerShape(MarkiroSizes.radius))
                    .padding(horizontal = 14.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(printer.name, style = t.strong, color = c.fg1)
                    Text("${if (printer.transport == "bluetooth") "Bluetooth" else "Wi-Fi"} · ${printer.address}", style = t.caption, color = c.fg2)
                    Text(stringResource(R.string.printer_language_dpi_value, printer.language.uppercase(), printer.dpi), style = t.caption, color = c.fg3)
                    printerStatusLabel(printer.lastStatus)?.let { label -> Text(stringResource(label), style = t.caption, color = c.tone(Tone.Err).fg) }
                    val purposes = PrintPurpose.entries.filter { routing.resolve(it)?.id == printer.id }
                    Text(if (purposes.isEmpty()) stringResource(R.string.printer_no_purposes)
                        else purposes.map { stringResource(purposeLabel(it)) }.joinToString(" · "), style = t.caption, color = c.accent)
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        ProfileAction(stringResource(R.string.printer_edit), Modifier.weight(1f)) { cb.onEdit(printer.id) }
                        ProfileAction(stringResource(R.string.printer_test_short), Modifier.weight(1f)) { cb.onTest(printer.id) }
                    }
                }
            }
        }
        Column(Modifier.fillMaxWidth().padding(MarkiroSizes.sp4), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            PrimaryButton(stringResource(R.string.printer_assignments), cb.onAssignments)
            SecondaryButton(stringResource(R.string.printer_add_by_address), cb.onAdd)
        }
    }
}

@Composable
private fun ProfileAction(label: String, modifier: Modifier, onClick: () -> Unit) {
    Box(modifier.heightIn(min = 48.dp).clip(RoundedCornerShape(MarkiroSizes.radius))
        .background(MarkiroTheme.colors.surfacePanel).clickable(onClick = onClick), contentAlignment = Alignment.Center) {
        Text(label, style = MarkiroTheme.type.label, color = MarkiroTheme.colors.fg1)
    }
}

@Composable
fun PrinterAssignmentsScreen(state: PrinterUi, onBack: () -> Unit, onAssign: (PrintPurpose, String?) -> Unit) {
    var choosing by remember { mutableStateOf<PrintPurpose?>(null) }
    val current = choosing
    val routing = PrinterRouting(state.printers, state.assignments)
    if (current != null) {
        PrinterChoiceScreen(current, state.printers, routing.resolve(current)?.id, { choosing = null }) {
            onAssign(current, it)
            choosing = null
        }
        return
    }
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Column(Modifier.fillMaxSize().background(c.surfacePage)) {
        AppBar(stringResource(R.string.printer_assignments), onBack)
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(MarkiroSizes.sp4),
            verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp3)) {
            Text(stringResource(R.string.printer_assignments_hint), style = t.body, color = c.fg2)
            PrintPurpose.entries.forEach { purpose ->
                val printer = routing.resolve(purpose)
                Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(MarkiroSizes.radius)).background(c.surfaceCard)
                    .border(1.dp, c.line, RoundedCornerShape(MarkiroSizes.radius)).clickable { choosing = purpose }
                    .padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(stringResource(purposeLabel(purpose)), style = t.label, color = c.fg3)
                    Text(printer?.name ?: stringResource(R.string.printer_unassigned), style = t.strong,
                        color = if (printer == null) c.tone(Tone.Warn).fg else c.fg1)
                    printer?.let { Text(it.address, style = t.caption, color = c.fg2) }
                    printerStatusLabel(printer?.lastStatus)?.let { label -> Text(stringResource(label), style = t.caption, color = c.tone(Tone.Err).fg) }
                    Text(stringResource(R.string.printer_choose), style = t.caption, color = c.fg2)
                }
            }
        }
    }
}

/** Used both by assignment settings and by explicit recovery of a single label. */
@Composable
fun PrinterChoiceScreen(
    purpose: PrintPurpose,
    printers: List<PrinterEntity>,
    selectedId: String?,
    onBack: () -> Unit,
    allowUnassigned: Boolean = true,
    onManage: (() -> Unit)? = null,
    onPick: (String?) -> Unit,
) {
    val c = MarkiroTheme.colors
    Column(Modifier.fillMaxSize().background(c.surfacePage)) {
        AppBar(stringResource(purposeLabel(purpose)), onBack)
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(MarkiroSizes.sp4),
            verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2)) {
            if (!allowUnassigned) Text(stringResource(if (purpose == PrintPurpose.DUPLICATE) R.string.printer_duplicate_compatible else R.string.printer_recovery_hint),
                style = MarkiroTheme.type.caption, color = c.fg2)
            if (allowUnassigned) ChoiceRow(stringResource(R.string.printer_unassigned), stringResource(R.string.printer_no_fallback), selectedId == null) { onPick(null) }
            if (printers.isEmpty()) Text(stringResource(R.string.printer_profiles_empty), style = MarkiroTheme.type.body, color = c.fg2)
            printers.forEach { printer ->
                ChoiceRow(printer.name, "${printer.address} · ${printer.language.uppercase()} ${printer.dpi} dpi", printer.id == selectedId) { onPick(printer.id) }
            }
        }
        if (onManage != null) Column(Modifier.padding(MarkiroSizes.sp4)) {
            SecondaryButton(stringResource(R.string.printers_title), onManage)
        }
    }
}

@Composable
fun AddPrinterScreen(form: AddPrinterForm, cb: AddPrinterCallbacks) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Column(Modifier.fillMaxSize().background(c.surfacePage)) {
        AppBar(stringResource(if (form.id == null) R.string.printer_add_title else R.string.printer_edit), cb.onBack)
        Column(
            Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = MarkiroSizes.sp4),
            verticalArrangement = Arrangement.spacedBy(MarkiroSizes.sp2),
        ) {
            Field(stringResource(R.string.printer_name), form.name, Modifier.fillMaxWidth(), cb.onName)
            Segmented(listOf(stringResource(R.string.printer_transport_wifi) to TransportKind.WIFI,
                stringResource(R.string.printer_transport_bluetooth) to TransportKind.BLUETOOTH), form.transport) {
                if (it == TransportKind.BLUETOOTH) cb.onBluetooth() else cb.onTransport(it)
            }

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
        }
        Column(Modifier.fillMaxWidth().padding(MarkiroSizes.sp4), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            PrimaryButton(stringResource(R.string.printer_check), cb.onCheck, enabled = !form.checking && form.host.isNotBlank())
            if (form.id != null) MarkiroTextButton(stringResource(R.string.printer_remove), cb.onRemove)
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
            if (state.addressConflict) Text(stringResource(R.string.printer_address_exists), style = t.body, color = c.tone(Tone.Err).fg)
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
        Column(Modifier.weight(1f)) {
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
