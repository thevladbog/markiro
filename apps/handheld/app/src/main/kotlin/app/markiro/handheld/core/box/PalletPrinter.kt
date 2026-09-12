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
import app.markiro.handheld.core.storage.PalletPrint

/**
 * Renders a closed pallet's label and sends it.
 *
 * `BoxPrinter` one level up, for the exact same reasons: the label is
 * re-rendered on every attempt rather than stored as bytes, because «Другой
 * принтер» may speak a different language at a different resolution; and
 * `closedAt` comes off the pallet's own row, never from the clock, so a
 * recovery print the next morning stamps the same «Дата производства» and
 * «Годен до» as the first attempt rather than that morning's.
 */
class PalletPrinter(
    private val db: HandheldDatabase,
    private val pallets: PalletRepository,
    private val renderer: LabelRenderer,
    private val transport: PrinterTransport,
) {
    suspend fun print(palletId: String): PrintOutcome {
        val pallet = db.palletDao().get(palletId) ?: return fail(palletId, PrintReason.PALLET_MISSING)
        val closedAt = pallet.closedAt ?: return fail(palletId, PrintReason.PALLET_OPEN)
        val sscc = pallet.sscc ?: return fail(palletId, PrintReason.PALLET_OPEN)
        val shift = db.shiftDao().get(pallet.shiftId) ?: return fail(palletId, PrintReason.SHIFT_MISSING)
        val templateJson = shift.palletLabelTemplateSpec ?: return fail(palletId, PrintReason.TEMPLATE_MISSING)
        val printer = db.printerDao().selected() ?: return fail(palletId, PrintReason.PRINTER_UNCONFIGURED)

        val spec = try {
            LabelSpecCodec.parse(templateJson)
        } catch (_: LabelRenderException) {
            return fail(palletId, PrintReason.TEMPLATE_INVALID)
        }

        // Asked before sending, so a refusal carries the printer's own reason
        // rather than a generic timeout -- the only reason «Нет бумаги» can
        // exist as a state at all.
        val status = transport.status(printer)
        if (status is PrinterStatus.NotReady) return fail(palletId, status.reason.wire())

        val fields = palletLabelFields(
            PalletLabelInput(
                sscc = sscc,
                boxCount = pallets.boxCount(palletId),
                itemCount = pallets.itemCount(palletId),
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

        pallets.setPrintState(palletId, PalletPrint.PRINTING, null)
        val document = try {
            renderer.render(spec, fields, PrinterLanguage.fromWire(printer.language), printer.dpi)
        } catch (_: LabelRenderException) {
            return fail(palletId, PrintReason.RENDER_FAILED)
        }

        return when (val outcome = transport.send(printer, document)) {
            SendOutcome.Delivered -> {
                pallets.setPrintState(palletId, PalletPrint.PRINTED, null)
                PrintOutcome.Printed
            }
            is SendOutcome.Refused -> fail(palletId, outcome.reason.wire())
            is SendOutcome.Unknown -> {
                pallets.setPrintState(palletId, PalletPrint.UNKNOWN, outcome.cause)
                PrintOutcome.Unknown(outcome.cause)
            }
        }
    }

    /** The operator looked at the printer and says the label is there. Nothing is sent. */
    suspend fun resolveUnknownAsPrinted(palletId: String) =
        pallets.setPrintState(palletId, PalletPrint.PRINTED, null)

    /**
     * Set aside for later, so a dead printer does not stop the line.
     *
     * Keeps whatever reason the last attempt gave, same as `BoxPrinter.defer`:
     * erasing it would leave the queue saying only that the label did not
     * print, which is both less useful and untrue.
     */
    suspend fun defer(palletId: String) =
        pallets.setPrintState(palletId, PalletPrint.DEFERRED, db.palletDao().get(palletId)?.printReason)

    private suspend fun fail(palletId: String, reason: String): PrintOutcome.Failed {
        pallets.setPrintState(palletId, PalletPrint.FAILED, reason)
        return PrintOutcome.Failed(reason)
    }

    private fun NotReadyReason.wire() = when (this) {
        NotReadyReason.NO_PAPER -> PrintReason.NO_PAPER
        NotReadyReason.HEAD_OPEN -> PrintReason.HEAD_OPEN
        NotReadyReason.UNREACHABLE -> PrintReason.UNREACHABLE
        NotReadyReason.OTHER -> PrintReason.TRANSPORT_FAILED
    }
}
