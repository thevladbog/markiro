package app.markiro.handheld.core.box

import app.markiro.handheld.core.label.LabelRenderException
import app.markiro.handheld.core.label.LabelRenderer
import app.markiro.handheld.core.label.LabelSpecCodec
import app.markiro.handheld.core.label.PrinterLanguage
import app.markiro.handheld.core.print.NotReadyReason
import app.markiro.handheld.core.print.PrinterStatus
import app.markiro.handheld.core.print.PrinterTransport
import app.markiro.handheld.core.print.SendOutcome
import app.markiro.handheld.core.storage.HandheldDatabase

sealed interface PrintOutcome {
    data object Printed : PrintOutcome

    /** Nothing was printed and we know it. The reason is the operator's next step. */
    data class Failed(val reason: String) : PrintOutcome

    /**
     * The bytes may or may not have reached the printer. Nothing resends from
     * here on its own: a retry could put a second label on a box the server has
     * already accepted, so only a person who has looked at the printer resolves it.
     */
    data class Unknown(val cause: String) : PrintOutcome
}

/** Why a label did not print, in the operator's terms rather than the transport's. */
object PrintReason {
    const val BOX_MISSING = "box_missing"
    const val BOX_OPEN = "box_open"
    const val SHIFT_MISSING = "shift_missing"
    const val TEMPLATE_MISSING = "template_missing"
    const val TEMPLATE_INVALID = "template_invalid"
    const val PRINTER_UNCONFIGURED = "printer_unconfigured"
    const val RENDER_FAILED = "render_failed"
    const val TRANSPORT_FAILED = "transport_failed"
    const val NO_PAPER = "no_paper"
    const val HEAD_OPEN = "head_open"
    const val UNREACHABLE = "unreachable"
}

/**
 * Renders a closed box's label and sends it.
 *
 * The label is re-rendered on every attempt rather than stored as bytes,
 * because «Другой принтер» may speak a different language at a different
 * resolution, and because the box row already holds everything a render needs.
 * `closedAt` comes off that row too, never from the clock: two labels for one
 * SSCC must not disagree about «Дата производства» and «Годен до», and a
 * recovery print the next morning would otherwise stamp that morning.
 */
class BoxPrinter(
    private val db: HandheldDatabase,
    private val boxes: BoxRepository,
    private val renderer: LabelRenderer,
    private val transport: PrinterTransport,
) {
    suspend fun print(boxId: String): PrintOutcome {
        val box = db.boxDao().get(boxId) ?: return fail(boxId, PrintReason.BOX_MISSING)
        val closedAt = box.closedAt ?: return fail(boxId, PrintReason.BOX_OPEN)
        val sscc = box.sscc ?: return fail(boxId, PrintReason.BOX_OPEN)
        val shift = db.shiftDao().get(box.shiftId) ?: return fail(boxId, PrintReason.SHIFT_MISSING)
        val templateJson = shift.boxLabelTemplate ?: return fail(boxId, PrintReason.TEMPLATE_MISSING)
        val printer = db.printerDao().selected() ?: return fail(boxId, PrintReason.PRINTER_UNCONFIGURED)

        val spec = try {
            LabelSpecCodec.parse(templateJson)
        } catch (_: LabelRenderException) {
            return fail(boxId, PrintReason.TEMPLATE_INVALID)
        }

        // Asked before sending, so a refusal carries the printer's own reason
        // rather than a generic timeout. It is the only reason «Нет бумаги» can
        // exist as a state at all.
        val status = transport.status(printer)
        if (status is PrinterStatus.NotReady) return fail(boxId, status.reason.wire())

        val fields = boxLabelFields(
            BoxLabelInput(
                sscc = sscc,
                itemCount = boxes.itemCount(boxId),
                productName = shift.productName.orEmpty(),
                productPrintName = shift.productPrintName,
                gtin14 = shift.productGtin14.orEmpty(),
                egaisCode = shift.egaisCode,
                shelfLifeDays = shift.shelfLifeDays,
                operatorName = null,
                counterpartyName = shift.counterpartyName,
                closedAt = closedAt,
                productionDate = shift.productionDate,
                shiftNumber = shift.number,
            ),
        )

        boxes.setPrintState(boxId, BoxPrint.PRINTING, null)
        val document = try {
            renderer.render(spec, fields, PrinterLanguage.fromWire(printer.language), printer.dpi)
        } catch (_: LabelRenderException) {
            return fail(boxId, PrintReason.RENDER_FAILED)
        }

        return when (val outcome = transport.send(printer, document)) {
            SendOutcome.Delivered -> {
                boxes.setPrintState(boxId, BoxPrint.PRINTED, null)
                PrintOutcome.Printed
            }
            is SendOutcome.Refused -> fail(boxId, outcome.reason.wire())
            is SendOutcome.Unknown -> {
                boxes.setPrintState(boxId, BoxPrint.UNKNOWN, outcome.cause)
                PrintOutcome.Unknown(outcome.cause)
            }
        }
    }

    /** The operator looked at the printer and says the label is there. Nothing is sent. */
    suspend fun resolveUnknownAsPrinted(boxId: String) =
        boxes.setPrintState(boxId, BoxPrint.PRINTED, null)

    /**
     * Set aside for later, so a dead printer does not stop the line.
     *
     * Keeps whatever reason the last attempt gave. Erasing it would leave the
     * queue saying only that the label did not print, which is both less useful
     * and untrue: the operator set it aside, and «Нет бумаги» is still why.
     */
    suspend fun defer(boxId: String) =
        boxes.setPrintState(boxId, BoxPrint.DEFERRED, db.boxDao().get(boxId)?.printReason)

    private suspend fun fail(boxId: String, reason: String): PrintOutcome.Failed {
        boxes.setPrintState(boxId, BoxPrint.FAILED, reason)
        return PrintOutcome.Failed(reason)
    }

    private fun NotReadyReason.wire() = when (this) {
        NotReadyReason.NO_PAPER -> PrintReason.NO_PAPER
        NotReadyReason.HEAD_OPEN -> PrintReason.HEAD_OPEN
        NotReadyReason.UNREACHABLE -> PrintReason.UNREACHABLE
        NotReadyReason.OTHER -> PrintReason.TRANSPORT_FAILED
    }
}
