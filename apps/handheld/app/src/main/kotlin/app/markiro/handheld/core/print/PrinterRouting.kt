package app.markiro.handheld.core.print

import androidx.room.Embedded
import androidx.room.Entity
import androidx.room.PrimaryKey
import app.markiro.handheld.core.storage.HandheldDatabase
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

enum class PrintPurpose(val wire: String) { BOX("box"), DUPLICATE("duplicate"), PALLET("pallet") }

@Entity(tableName = "printer_assignments")
data class PrinterAssignmentEntity(@PrimaryKey val purpose: String, val printerId: String?)

/** Device-local only. No foreign key: removing a profile must retain a pending attempt's destination. */
@Entity(tableName = "print_destinations", primaryKeys = ["purpose", "jobId", "attemptId"])
data class PrintDestinationEntity(
    val purpose: String,
    val jobId: String,
    val attemptId: String,
    @Embedded(prefix = "printer_") val printer: PrinterEntity,
)

data class PrinterRouting(val printers: List<PrinterEntity>, val assignments: List<PrinterAssignmentEntity>) {
    fun resolve(purpose: PrintPurpose): PrinterEntity? = assignments.firstOrNull { it.purpose == purpose.wire }
        ?.printerId?.let { id -> printers.firstOrNull { it.id == id } }
    val missing: List<PrintPurpose> get() = PrintPurpose.entries.filter { resolve(it) == null }
    val attention: List<PrintPurpose> get() = PrintPurpose.entries.filter { resolve(it)?.lastStatus in PRINTER_PROBLEMS }
}

suspend fun PrinterDao.assigned(purpose: PrintPurpose): PrinterEntity? = assigned(purpose.wire)
fun PrinterDao.observeRouting() = combine(observeAll(), observeAssignments(), ::PrinterRouting)

fun normalizedPrinterAddress(transport: String, address: String): String = when (transport) {
    "bluetooth" -> address.trim().uppercase(Locale.ROOT)
    else -> WifiPrinterConnector.parseAddress(address.trim()).let { (host, port) ->
        "${host.trim().trimEnd('.').lowercase(Locale.ROOT)}:$port"
    }
}

fun printerEndpointKey(printer: PrinterEntity): String =
    "${printer.transport}:${normalizedPrinterAddress(printer.transport, printer.address)}"

/** One lock for the physical endpoint across purposes, test prints and transport instances. */
object PrinterOutput {
    private val locks = ConcurrentHashMap<String, Mutex>()
    suspend fun <T> serialized(printer: PrinterEntity, output: suspend () -> T): T =
        locks.getOrPut(printerEndpointKey(printer)) { Mutex() }.withLock { output() }
}

/** Pin before rendering/sending; only an explicit recovery action may replace a saved destination. */
class PrintDestinations(private val db: HandheldDatabase) {
    suspend fun get(purpose: PrintPurpose, jobId: String, attemptId: String = "initial"): PrinterEntity? =
        db.printerDao().destination(purpose.wire, jobId, attemptId)?.printer

    suspend fun retain(
        purpose: PrintPurpose,
        jobId: String,
        attemptId: String = "initial",
        candidate: PrinterEntity? = null,
    ): PrinterEntity? = db.recovery.commit {
        get(purpose, jobId, attemptId) ?: (candidate ?: db.printerDao().assigned(purpose))?.also {
            db.printerDao().saveDestination(PrintDestinationEntity(purpose.wire, jobId, attemptId, it))
        }
    }

    suspend fun replace(purpose: PrintPurpose, jobId: String, attemptId: String, printer: PrinterEntity) =
        db.recovery.commit {
            // Box/pallet recovery has no server attempt id. Preserve its previous local snapshot
            // before advancing the current attempt; prepared duplicate attempts are never replaced.
            db.printerDao().destination(purpose.wire, jobId, attemptId)?.let { previous ->
                db.printerDao().saveDestination(previous.copy(attemptId = UUID.randomUUID().toString()))
            }
            db.printerDao().saveDestination(PrintDestinationEntity(purpose.wire, jobId, attemptId, printer))
        }
}

private val PRINTER_PROBLEMS = setOf("no_paper", "head_open", "unreachable", "other", "unknown")

private suspend fun rememberStatus(dao: PrinterDao, recovery: app.markiro.handheld.core.storage.DeviceRecovery,
    printer: PrinterEntity, status: String, at: Long) = recovery.commit {
    // A response from an old snapshot must not overwrite a newly edited endpoint's status.
    dao.setSnapshotStatus(printer.id, printer.address, printer.transport, printer.language, printer.dpi, status, at)
}

suspend fun PrinterTransport.statusRemembered(printer: PrinterEntity, dao: PrinterDao,
    recovery: app.markiro.handheld.core.storage.DeviceRecovery, at: Long = System.currentTimeMillis()): PrinterStatus {
    val result = status(printer)
    val value = when (result) {
        PrinterStatus.Ready -> "ready"
        is PrinterStatus.NotReady -> result.reason.name.lowercase(Locale.ROOT)
    }
    rememberStatus(dao, recovery, printer, value, at)
    return result
}

suspend fun PrinterTransport.sendRemembered(printer: PrinterEntity, document: ByteArray, dao: PrinterDao,
    recovery: app.markiro.handheld.core.storage.DeviceRecovery, at: Long = System.currentTimeMillis()): SendOutcome {
    val result = send(printer, document)
    val value = when (result) {
        SendOutcome.Delivered -> "ready"
        is SendOutcome.Refused -> result.reason.name.lowercase(Locale.ROOT)
        is SendOutcome.Unknown -> "unknown"
    }
    rememberStatus(dao, recovery, printer, value, at)
    return result
}
