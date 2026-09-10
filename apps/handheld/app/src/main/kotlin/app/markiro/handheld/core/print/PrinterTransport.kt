package app.markiro.handheld.core.print

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.Closeable
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream

/** The drawn timeout: a printer that has not answered in five seconds is not answering. */
const val PRINTER_TIMEOUT_MS = 5_000

enum class NotReadyReason { NO_PAPER, HEAD_OPEN, UNREACHABLE, OTHER }

sealed interface PrinterStatus {
    data object Ready : PrinterStatus
    data class NotReady(val reason: NotReadyReason) : PrinterStatus
}

/**
 * What became of a document.
 *
 * `Refused` and `Unknown` are deliberately different. Refused means nothing was printed and we know
 * it. Unknown means the bytes may or may not have arrived, and nothing may resend on its own from
 * there: an automatic retry could put a second label on a box the server has already accepted. Only
 * a person who has looked at the printer resolves an unknown.
 */
sealed interface SendOutcome {
    data object Delivered : SendOutcome
    data class Refused(val reason: NotReadyReason) : SendOutcome
    data class Unknown(val cause: String) : SendOutcome
}

interface PrinterConnection : Closeable {
    val input: InputStream
    val output: OutputStream
}

fun interface PrinterConnector {
    /** Opens a connection, or throws `IOException` when the printer cannot be reached at all. */
    suspend fun open(printer: PrinterEntity): PrinterConnection
}

/** What a screen needs from a printer. Separated from the socket work so a view model can be tested. */
interface PrinterTransport {
    suspend fun status(printer: PrinterEntity): PrinterStatus
    suspend fun send(printer: PrinterEntity, document: ByteArray): SendOutcome
}

/**
 * Status and send over any byte stream. Neither printer language acknowledges a print job, so
 * `Delivered` means the bytes left this device, not that paper moved. That is exactly why the status
 * query runs first and why the operator confirms afterwards.
 */
class StreamPrinterTransport(private val connectors: (PrinterEntity) -> PrinterConnector) : PrinterTransport {

    override suspend fun status(printer: PrinterEntity): PrinterStatus = withContext(Dispatchers.IO) {
        val query = if (printer.language == "tspl") TSPL_STATUS_QUERY else ZPL_STATUS_QUERY
        val reply = try {
            connectors(printer).open(printer).use { connection ->
                connection.output.write(query)
                connection.output.flush()
                connection.input.readBytes()
            }
        } catch (_: IOException) {
            return@withContext PrinterStatus.NotReady(NotReadyReason.UNREACHABLE)
        }
        if (reply.isEmpty()) return@withContext PrinterStatus.NotReady(NotReadyReason.UNREACHABLE)
        if (printer.language == "tspl") decodeTsplStatus(reply) else decodeZplStatus(reply)
    }

    override suspend fun send(printer: PrinterEntity, document: ByteArray): SendOutcome = withContext(Dispatchers.IO) {
        val connection = try {
            connectors(printer).open(printer)
        } catch (_: IOException) {
            return@withContext SendOutcome.Refused(NotReadyReason.UNREACHABLE)
        }
        try {
            connection.use {
                it.output.write(document)
                it.output.flush()
            }
            SendOutcome.Delivered
        } catch (e: IOException) {
            // The connection was open, so some or all of the document may already be on the printer.
            SendOutcome.Unknown(e.message ?: "link lost")
        }
    }
}

/** Host status query. The reply's error line carries a flag and two masks. */
private val ZPL_STATUS_QUERY = "~HQES".toByteArray(Charsets.US_ASCII)

/** Escape, bang, question mark: the reply is a single status byte. */
private val TSPL_STATUS_QUERY = byteArrayOf(0x1B, 0x21, 0x3F)

private val ERRORS_LINE = Regex("ERRORS:\\s*(\\d)\\s+[0-9A-Fa-f]+\\s+([0-9A-Fa-f]+)")

/**
 * Decodes the host status reply. Only the two conditions the printer screen names are mapped by
 * name; anything else the printer flags becomes a generic refusal rather than a guess. The exact
 * flag bits are the part of this file most likely to need adjusting against real hardware.
 */
internal fun decodeZplStatus(reply: ByteArray): PrinterStatus {
    val match = ERRORS_LINE.find(String(reply, Charsets.US_ASCII))
        ?: return PrinterStatus.NotReady(NotReadyReason.OTHER)
    if (match.groupValues[1] == "0") return PrinterStatus.Ready
    val mask = match.groupValues[2].toLongOrNull(16) ?: return PrinterStatus.NotReady(NotReadyReason.OTHER)
    return when {
        mask and 0x1L != 0L -> PrinterStatus.NotReady(NotReadyReason.NO_PAPER)
        mask and 0x4L != 0L -> PrinterStatus.NotReady(NotReadyReason.HEAD_OPEN)
        else -> PrinterStatus.NotReady(NotReadyReason.OTHER)
    }
}

/** The single status byte: zero is normal, and the low bits flag the two conditions we name. */
internal fun decodeTsplStatus(reply: ByteArray): PrinterStatus {
    val value = reply.first().toInt() and 0xFF
    return when {
        value == 0 -> PrinterStatus.Ready
        value and 0x04 != 0 -> PrinterStatus.NotReady(NotReadyReason.NO_PAPER)
        value and 0x01 != 0 -> PrinterStatus.NotReady(NotReadyReason.HEAD_OPEN)
        else -> PrinterStatus.NotReady(NotReadyReason.OTHER)
    }
}
