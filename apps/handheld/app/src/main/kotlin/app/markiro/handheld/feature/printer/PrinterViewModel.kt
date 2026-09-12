package app.markiro.handheld.feature.printer

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.core.label.LabelRenderer
import app.markiro.handheld.core.label.PrinterLanguage
import app.markiro.handheld.core.label.TestLabel
import app.markiro.handheld.core.print.BluetoothPrinterConnector
import app.markiro.handheld.core.print.DiscoveredPrinter
import app.markiro.handheld.core.print.PrintPurpose
import app.markiro.handheld.core.print.PrinterAssignmentEntity
import app.markiro.handheld.core.print.PrinterRouting
import app.markiro.handheld.core.print.observeRouting
import app.markiro.handheld.core.print.normalizedPrinterAddress
import app.markiro.handheld.core.print.printerEndpointKey
import app.markiro.handheld.core.print.NotReadyReason
import app.markiro.handheld.core.print.PrinterDao
import app.markiro.handheld.core.print.PrinterEntity
import app.markiro.handheld.core.print.PrinterStatus
import app.markiro.handheld.core.print.statusRemembered
import app.markiro.handheld.core.print.sendRemembered
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
    val assignments: List<PrinterAssignmentEntity> = emptyList(),
    val paired: List<DiscoveredPrinter> = emptyList(),
    val permissionNeeded: Boolean = false,
    val addressConflict: Boolean = false,
)

data class AddPrinterForm(
    val id: String? = null,
    val name: String = "",
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
    private val recovery: app.markiro.handheld.core.storage.DeviceRecovery,
    private val printers: PrinterDao,
    private val transport: PrinterTransport,
    private val renderer: LabelRenderer,
    private val pairedPrinters: () -> List<DiscoveredPrinter>,
    private val clock: () -> Long,
) : ViewModel() {
    @Inject
    constructor(
        recovery: app.markiro.handheld.core.storage.DeviceRecovery,
        printers: PrinterDao,
        transport: PrinterTransport,
        renderer: LabelRenderer,
        bluetooth: BluetoothPrinterConnector,
    ) : this(recovery, printers, transport, renderer, { bluetooth.pairedPrinters() }, System::currentTimeMillis)

    private val local = MutableStateFlow(PrinterUi())
    val state: StateFlow<PrinterUi> = combine(printers.observeRouting(), local) { routing, ui ->
        ui.copy(printers = routing.printers, assignments = routing.assignments, selected = routing.printers.firstOrNull { it.id == ui.selected?.id })
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
        local.update { it.copy(selected = state.value.printers.firstOrNull { row -> row.id == id }) }
    }

    fun assign(purpose: PrintPurpose, id: String?) {
        viewModelScope.launch { recovery.work { recovery.commit {
            if (id == null || printers.get(id) != null) printers.assign(PrinterAssignmentEntity(purpose.wire, id))
        } } }
    }

    fun remove(id: String) {
        viewModelScope.launch { recovery.work { recovery.commit {
            state.value.assignments.filter { it.printerId == id }.forEach { printers.assign(it.copy(printerId = null)) }
            printers.delete(id)
        } } }
    }

    fun startEdit(id: String) {
        val printer = state.value.printers.firstOrNull { it.id == id } ?: return
        select(id)
        val (host, port) = if (printer.transport == "wifi") WifiPrinterConnector.parseAddress(printer.address) else printer.address to 9100
        _addForm.value = AddPrinterForm(id = id, name = printer.name,
            transport = if (printer.transport == "wifi") TransportKind.WIFI else TransportKind.BLUETOOTH,
            host = host, port = port.toString(), language = PrinterLanguage.fromWire(printer.language), dpi = printer.dpi)
    }

    fun editName(value: String) = _addForm.update { it.copy(name = value, error = null) }

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
        if (form.host.isBlank() || form.checking) return
        val address = normalizedPrinterAddress(transportWire, if (form.transport == TransportKind.WIFI) "${form.host.trim()}:$port" else form.host)
        _addForm.update { it.copy(checking = true, error = null) }
        viewModelScope.launch { recovery.work {
            // Adding the same address twice means the same printer, so its row is updated rather
            // than duplicated. Without this a second press of the check button leaves two identical
            // entries the operator cannot tell apart.
            val existing = printers.all().firstOrNull { it.transport == transportWire && normalizedPrinterAddress(it.transport, it.address) == address }
            if (existing != null && form.id != null && existing.id != form.id) {
                _addForm.update { it.copy(checking = false, error = NotReadyReason.OTHER) }; return@work
            }
            val candidate = PrinterEntity(
                id = form.id ?: existing?.id ?: UUID.randomUUID().toString(),
                name = form.name.trim().ifBlank { existing?.name ?: form.host.trim() },
                transport = transportWire,
                address = address,
                language = form.language.wire,
                dpi = form.dpi,
                selected = false,
                lastStatus = null,
                lastSeenAt = null,
            )
            when (val status = transport.status(candidate)) {
                is PrinterStatus.Ready -> {
                    recovery.commit { printers.upsert(candidate.copy(lastStatus = "ready", lastSeenAt = clock())) }
                    local.update { it.copy(selected = candidate) }
                    _addForm.value = AddPrinterForm()
                    _saved.tryEmit(Unit)
                }
                is PrinterStatus.NotReady -> _addForm.update { it.copy(checking = false, error = status.reason) }
            }
        } }
    }

    fun loadPairedDevices() {
        viewModelScope.launch { recovery.work {
            val found = runCatching { pairedPrinters() }.getOrElse {
                local.update { ui -> ui.copy(permissionNeeded = true) }
                return@work
            }
            local.update { it.copy(paired = found, permissionNeeded = false) }
        } }
    }

    fun pickPairedDevice(device: DiscoveredPrinter) {
        val form = _addForm.value
        if (form.checking) return
        _addForm.update { it.copy(checking = true) }
        local.update { it.copy(addressConflict = false) }
        viewModelScope.launch { recovery.work {
            // The same device picked twice is the same printer, exactly as for a network address.
            // Without this the list fills with identical rows the operator cannot tell apart.
            val existing = printers.all().firstOrNull { it.transport == "bluetooth" && normalizedPrinterAddress("bluetooth", it.address) == normalizedPrinterAddress("bluetooth", device.address) }
            if (existing != null && form.id != null && existing.id != form.id) {
                _addForm.update { it.copy(checking = false) }
                local.update { it.copy(addressConflict = true) }
                return@work
            }
            val printer = PrinterEntity(
                id = form.id ?: existing?.id ?: UUID.randomUUID().toString(),
                name = form.name.trim().ifBlank { device.name },
                transport = TransportKind.BLUETOOTH.wire,
                address = normalizedPrinterAddress("bluetooth", device.address),
                language = form.language.wire,
                dpi = form.dpi,
                selected = false,
                lastStatus = null,
                lastSeenAt = null,
            )
            recovery.commit { printers.upsert(printer) }
            local.update { it.copy(selected = printer) }
            _addForm.value = AddPrinterForm()
            _saved.tryEmit(Unit)
        } }
    }

    /**
     * Asks the printer how it is, then sends. The question comes first because neither printer
     * language acknowledges a job afterwards: without it the only failure this screen could ever
     * report is silence, and the drawn out-of-paper state could not exist.
     */
    private var testPrinter: PrinterEntity? = null
    fun printTest(id: String? = state.value.selected?.id) {
        if (_testStep.value == TestPrintStep.Sending) return
        val printer = state.value.printers.firstOrNull { it.id == id } ?: return
        testPrinter = printer
        sendTest(printer)
    }

    private fun sendTest(printer: PrinterEntity) {
        _testStep.value = TestPrintStep.Sending
        viewModelScope.launch { recovery.work {
            val status = transport.statusRemembered(printer, printers, recovery, clock())
            if (status is PrinterStatus.NotReady) {
                _testStep.value = TestPrintStep.Failed(status.reason)
                return@work
            }
            val document = renderer.render(
                TestLabel.spec(),
                TestLabel.data(),
                PrinterLanguage.fromWire(printer.language),
                printer.dpi,
            )
            _testStep.value = recovery.printing { when (val outcome = transport.sendRemembered(printer, document, printers, recovery, clock())) {
                is SendOutcome.Delivered -> TestPrintStep.Sent("${printer.name} · ${printer.address}")
                is SendOutcome.Refused -> TestPrintStep.Failed(outcome.reason)
                is SendOutcome.Unknown -> TestPrintStep.Unknown(outcome.cause)
            } }
        } }
    }

    /** The operator looked at the printer and says the label is there. Nothing is sent. */
    fun confirmTestPrinted() {
        _testStep.value = TestPrintStep.Idle
    }

    /** An explicit second send, chosen by a person who has looked at the printer. */
    fun retryTest() {
        if (_testStep.value == TestPrintStep.Sending) return
        testPrinter?.let(::sendTest)
    }

    fun dismissTest() {
        _testStep.value = TestPrintStep.Idle
    }
}
