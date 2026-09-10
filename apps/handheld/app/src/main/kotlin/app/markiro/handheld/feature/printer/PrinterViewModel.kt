package app.markiro.handheld.feature.printer

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.core.label.LabelRenderer
import app.markiro.handheld.core.label.PrinterLanguage
import app.markiro.handheld.core.label.TestLabel
import app.markiro.handheld.core.print.BluetoothPrinterConnector
import app.markiro.handheld.core.print.DiscoveredPrinter
import app.markiro.handheld.core.print.NotReadyReason
import app.markiro.handheld.core.print.PrinterDao
import app.markiro.handheld.core.print.PrinterEntity
import app.markiro.handheld.core.print.PrinterStatus
import app.markiro.handheld.core.print.PrinterTransport
import app.markiro.handheld.core.print.SendOutcome
import app.markiro.handheld.core.print.WifiPrinterConnector
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.UUID
import javax.inject.Inject

enum class TransportKind(val wire: String) { WIFI("wifi"), BLUETOOTH("bluetooth") }

data class PrinterUi(
    val printers: List<PrinterEntity> = emptyList(),
    val selected: PrinterEntity? = null,
    val paired: List<DiscoveredPrinter> = emptyList(),
    val permissionNeeded: Boolean = false,
)

data class AddPrinterForm(
    val transport: TransportKind = TransportKind.WIFI,
    val host: String = "",
    val port: String = WifiPrinterConnector.DEFAULT_PORT.toString(),
    val language: PrinterLanguage = PrinterLanguage.ZPL,
    val dpi: Int = 203,
    val checking: Boolean = false,
    /** Set when the check came back with something other than a ready printer. */
    val error: NotReadyReason? = null,
)

sealed interface TestPrintStep {
    data object Idle : TestPrintStep
    data object Sending : TestPrintStep

    /** The bytes left the device. The operator now says whether the label is clean. */
    data class Sent(val printerLabel: String) : TestPrintStep
    data class Failed(val reason: NotReadyReason) : TestPrintStep

    /** The link broke partway. Nothing resends from here without a person. */
    data class Unknown(val cause: String) : TestPrintStep
}

@HiltViewModel
class PrinterViewModel(
    private val printers: PrinterDao,
    private val transport: PrinterTransport,
    private val renderer: LabelRenderer,
    private val pairedPrinters: () -> List<DiscoveredPrinter>,
    private val clock: () -> Long,
) : ViewModel() {
    @Inject
    constructor(
        printers: PrinterDao,
        transport: PrinterTransport,
        renderer: LabelRenderer,
        bluetooth: BluetoothPrinterConnector,
    ) : this(printers, transport, renderer, { bluetooth.pairedPrinters() }, System::currentTimeMillis)

    private val local = MutableStateFlow(PrinterUi())
    val state: StateFlow<PrinterUi> = combine(printers.observeAll(), local) { rows, ui ->
        ui.copy(printers = rows, selected = rows.firstOrNull { it.selected })
    }.stateIn(viewModelScope, SharingStarted.Eagerly, PrinterUi())

    private val _addForm = MutableStateFlow(AddPrinterForm())
    val addForm: StateFlow<AddPrinterForm> = _addForm

    private val _testStep = MutableStateFlow<TestPrintStep>(TestPrintStep.Idle)
    val testStep: StateFlow<TestPrintStep> = _testStep

    private val _saved = MutableSharedFlow<Unit>(extraBufferCapacity = 1)

    /**
     * A printer answered and was stored. The form has nothing left to say at that point, so without
     * this the operator watches it blank itself and has to guess whether anything happened.
     */
    val saved: SharedFlow<Unit> = _saved

    fun select(id: String) {
        viewModelScope.launch { printers.select(id) }
    }

    fun remove(id: String) {
        viewModelScope.launch { printers.delete(id) }
    }

    /** Enters the add flow with an empty form. */
    fun startAdd(transport: TransportKind) {
        _addForm.value = AddPrinterForm(transport = transport)
    }

    /**
     * Switches the transport within the flow the operator is already in, keeping the language and
     * resolution they picked. The Bluetooth path needs both: they carry over to the paired device.
     */
    fun setTransport(transport: TransportKind) = _addForm.update { it.copy(transport = transport, error = null) }

    fun editHost(value: String) = _addForm.update { it.copy(host = value, error = null) }

    fun editPort(value: String) = _addForm.update { it.copy(port = value.filter(Char::isDigit), error = null) }

    fun setLanguage(language: PrinterLanguage) = _addForm.update { it.copy(language = language, error = null) }

    fun setDpi(dpi: Int) = _addForm.update { it.copy(dpi = dpi, error = null) }

    /**
     * Asks the printer how it is before saving anything. A printer that answers with a problem keeps
     * the operator on the form with its own words, rather than being saved and failing later.
     */
    fun checkAndSave() {
        val form = _addForm.value
        // Normalized here as well as in the connector, so the address the list shows is the address
        // the socket will actually use.
        val port = WifiPrinterConnector.normalizePort(form.port)
        val transportWire = form.transport.wire
        val address = if (form.transport == TransportKind.WIFI) "${form.host}:$port" else form.host
        _addForm.update { it.copy(checking = true, error = null) }
        viewModelScope.launch {
            // Adding the same address twice means the same printer, so its row is updated rather
            // than duplicated. Without this a second press of the check button leaves two identical
            // entries the operator cannot tell apart.
            val existing = printers.findByAddress(transportWire, address)
            val candidate = PrinterEntity(
                id = existing?.id ?: UUID.randomUUID().toString(),
                name = form.host.ifBlank { existing?.name ?: "printer" },
                transport = transportWire,
                address = address,
                language = form.language.wire,
                dpi = form.dpi,
                selected = true,
                lastStatus = null,
                lastSeenAt = null,
            )
            when (val status = transport.status(candidate)) {
                is PrinterStatus.Ready -> {
                    printers.upsert(candidate.copy(lastStatus = "ready", lastSeenAt = clock()))
                    printers.select(candidate.id)
                    _addForm.value = AddPrinterForm()
                    _saved.tryEmit(Unit)
                }
                is PrinterStatus.NotReady -> _addForm.update { it.copy(checking = false, error = status.reason) }
            }
        }
    }

    fun loadPairedDevices() {
        viewModelScope.launch {
            val found = runCatching { pairedPrinters() }.getOrElse {
                local.update { ui -> ui.copy(permissionNeeded = true) }
                return@launch
            }
            local.update { it.copy(paired = found, permissionNeeded = false) }
        }
    }

    fun pickPairedDevice(device: DiscoveredPrinter) {
        val form = _addForm.value
        viewModelScope.launch {
            // The same device picked twice is the same printer, exactly as for a network address.
            // Without this the list fills with identical rows the operator cannot tell apart.
            val existing = printers.findByAddress(TransportKind.BLUETOOTH.wire, device.address)
            val printer = PrinterEntity(
                id = existing?.id ?: UUID.randomUUID().toString(),
                name = device.name,
                transport = TransportKind.BLUETOOTH.wire,
                address = device.address,
                language = form.language.wire,
                dpi = form.dpi,
                selected = true,
                lastStatus = null,
                lastSeenAt = null,
            )
            printers.upsert(printer)
            printers.select(printer.id)
        }
    }

    /**
     * Asks the printer how it is, then sends. The question comes first because neither printer
     * language acknowledges a job afterwards: without it the only failure this screen could ever
     * report is silence, and the drawn out-of-paper state could not exist.
     */
    fun printTest() {
        val printer = state.value.selected ?: return
        _testStep.value = TestPrintStep.Sending
        viewModelScope.launch {
            val status = transport.status(printer)
            if (status is PrinterStatus.NotReady) {
                _testStep.value = TestPrintStep.Failed(status.reason)
                printers.setStatus(printer.id, null, clock())
                return@launch
            }
            val document = renderer.render(
                TestLabel.spec(),
                TestLabel.data(),
                PrinterLanguage.fromWire(printer.language),
                printer.dpi,
            )
            _testStep.value = when (val outcome = transport.send(printer, document)) {
                is SendOutcome.Delivered -> TestPrintStep.Sent("${printer.name} · ${printer.address}")
                is SendOutcome.Refused -> TestPrintStep.Failed(outcome.reason)
                is SendOutcome.Unknown -> TestPrintStep.Unknown(outcome.cause)
            }
            printers.setStatus(printer.id, if (_testStep.value is TestPrintStep.Sent) "ready" else null, clock())
        }
    }

    /** The operator looked at the printer and says the label is there. Nothing is sent. */
    fun confirmTestPrinted() {
        _testStep.value = TestPrintStep.Idle
    }

    /** An explicit second send, chosen by a person who has looked at the printer. */
    fun retryTest() = printTest()

    fun dismissTest() {
        _testStep.value = TestPrintStep.Idle
    }
}
