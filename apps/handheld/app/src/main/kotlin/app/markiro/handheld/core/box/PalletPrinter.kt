package app.markiro.handheld.core.box

import app.markiro.handheld.core.label.LabelRenderException
import app.markiro.handheld.core.label.LabelRenderer
import app.markiro.handheld.core.label.LabelSpecCodec
import app.markiro.handheld.core.label.PrinterLanguage
import app.markiro.handheld.core.print.PrintDestinations
import app.markiro.handheld.core.print.assigned
import app.markiro.handheld.core.print.PrintPurpose
import app.markiro.handheld.core.print.NotReadyReason
import app.markiro.handheld.core.print.PrinterStatus
import app.markiro.handheld.core.print.statusRemembered
import app.markiro.handheld.core.print.sendRemembered
import app.markiro.handheld.core.print.PrinterTransport
import app.markiro.handheld.core.print.SendOutcome
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.PalletEntity
import app.markiro.handheld.core.storage.PalletKind
import app.markiro.handheld.core.storage.PalletLabelTemplateEntity
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
 *
 * Every entry point runs under the device-recovery lease `BoxPrinter` uses, so
 * a credential rejected while a pallet label is in flight blocks the write that
 * would record it instead of stamping a state against an owner this device no
 * longer is.
 */
class PalletPrinter(
    private val db: HandheldDatabase,
    private val pallets: PalletRepository,
    private val renderer: LabelRenderer,
    private val transport: PrinterTransport,
) {
    suspend fun print(palletId: String, replacementPrinterId: String? = null, allowUnknown: Boolean = false, reprint: Boolean = false): PrintOutcome = db.recovery.printing {
        if (replacementPrinterId != null) {
            val replacement = db.printerDao().get(replacementPrinterId)
                ?: return@printing PrintOutcome.Failed(PrintReason.PRINTER_UNCONFIGURED)
            PrintDestinations(db).replace(PrintPurpose.PALLET, palletId, "initial", replacement)
        }
        printOwned(palletId, allowUnknown, reprint, replacementPrinterId != null)
    }

    private suspend fun printOwned(palletId: String, allowUnknown: Boolean, reprint: Boolean, replaced: Boolean): PrintOutcome {
        val pallet = db.palletDao().get(palletId) ?: return fail(palletId, PrintReason.PALLET_MISSING)
        if (pallet.printState == PalletPrint.PRINTED && !reprint && !replaced) return PrintOutcome.Printed
        if (pallet.printState == PalletPrint.UNKNOWN && !allowUnknown) return PrintOutcome.Unknown(pallet.printReason ?: "interrupted")
        val closedAt = pallet.closedAt ?: return fail(palletId, PrintReason.PALLET_OPEN)
        val sscc = pallet.sscc ?: return fail(palletId, PrintReason.PALLET_OPEN)
        // A warehouse pallet has no shift and no shift-bound template: its
        // product, its template and its dates come from the bootstrap caches
        // and the membership rows instead.
        val source = if (pallet.kind == PalletKind.WAREHOUSE) warehouseSource(pallet, sscc, closedAt) else shiftSource(pallet, sscc, closedAt)
        val ready = when (source) {
            is Source.Ready -> source
            is Source.Refused -> return fail(palletId, source.reason)
        }
        val templateJson = ready.templateJson
        val destinations = PrintDestinations(db)
        if (reprint && pallet.printState == PalletPrint.PRINTED && !replaced) {
            val current = db.printerDao().assigned(PrintPurpose.PALLET) ?: return fail(palletId, PrintReason.PRINTER_UNCONFIGURED)
            destinations.replace(PrintPurpose.PALLET, palletId, "initial", current)
        }
        val printer = destinations.retain(PrintPurpose.PALLET, palletId) ?: return fail(palletId, PrintReason.PRINTER_UNCONFIGURED)

        val spec = try {
            LabelSpecCodec.parse(templateJson)
        } catch (_: LabelRenderException) {
            return fail(palletId, PrintReason.TEMPLATE_INVALID)
        }

        // Asked before sending, so a refusal carries the printer's own reason
        // rather than a generic timeout -- the only reason «Нет бумаги» can
        // exist as a state at all.
        val status = transport.statusRemembered(printer, db.printerDao(), db.recovery)
        if (status is PrinterStatus.NotReady) return fail(palletId, status.reason.wire())

        val boxCount = if (pallet.kind == PalletKind.WAREHOUSE) {
            db.palletMembershipDao().countOnPallet(palletId)
        } else {
            pallets.boxCount(palletId)
        }
        val itemCount = if (pallet.kind == PalletKind.WAREHOUSE) {
            db.palletMembershipDao().bottleSum(palletId)
        } else {
            pallets.itemCount(palletId)
        }
        val fields = palletLabelFields(ready.input(boxCount, itemCount), omitDates = ready.omitDates)

        pallets.setPrintState(palletId, PalletPrint.PRINTING, null)
        val document = try {
            renderer.render(spec, fields, PrinterLanguage.fromWire(printer.language), printer.dpi)
        } catch (_: LabelRenderException) {
            return fail(palletId, PrintReason.RENDER_FAILED)
        }

        if (!db.recovery.valid(checkNotNull(app.markiro.handheld.core.storage.DeviceRecovery.generationContext.get()))) {
            throw app.markiro.handheld.core.storage.RecoveryBlocked()
        }
        return when (val outcome = transport.sendRemembered(printer, document, db.printerDao(), db.recovery)) {
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

    /**
     * Where one pallet's label facts come from.
     *
     * A production pallet reads them off its shift; a warehouse pallet has no
     * shift and reads them off the bootstrap caches and its own membership
     * rows. Modelled as one type so the rest of `printOwned` -- the status
     * check, the `printing` state, the render and the send -- stays a single
     * path that neither kind can drift away from.
     */
    private sealed interface Source {
        data class Ready(
            val templateJson: String,
            val input: (boxCount: Int, itemCount: Int) -> PalletLabelInput,
            val omitDates: Boolean,
        ) : Source

        data class Refused(val reason: String) : Source
    }

    private suspend fun shiftSource(pallet: PalletEntity, sscc: String, closedAt: String): Source {
        val shiftId = pallet.shiftId ?: return Source.Refused(PrintReason.SHIFT_MISSING)
        val shift = db.shiftDao().get(shiftId) ?: return Source.Refused(PrintReason.SHIFT_MISSING)
        val templateJson = shift.palletLabelTemplateSpec ?: return Source.Refused(PrintReason.TEMPLATE_MISSING)
        return Source.Ready(
            templateJson,
            { boxCount, itemCount ->
                PalletLabelInput(
                    sscc = sscc,
                    boxCount = boxCount,
                    itemCount = itemCount,
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
                )
            },
            omitDates = false,
        )
    }

    /**
     * The product is the pallet's own, the template is the catalog category's
     * before the organisation's, and the production date is only printed when
     * every member box agrees on one: see `palletLabelFields`' `omitDates` for
     * why a rack of two shifts gets a blank «Годен до» rather than a guess.
     */
    private suspend fun warehouseSource(pallet: PalletEntity, sscc: String, closedAt: String): Source {
        val product = pallet.productId?.let { db.palletProductDao().byId(it) }
            ?: return Source.Refused(PrintReason.PRODUCT_MISSING)
        val template = product.chzProductGroupCode?.let { db.palletLabelTemplateDao().get(PalletLabelTemplateEntity.category(it)) }
            ?: db.palletLabelTemplateDao().get(PalletLabelTemplateEntity.ORG)
            ?: return Source.Refused(PrintReason.TEMPLATE_MISSING)
        val dates = db.palletMembershipDao().productionDates(pallet.palletId)
        val uniform = dates.singleOrNull()
        return Source.Ready(
            template.specJson,
            { boxCount, itemCount ->
                PalletLabelInput(
                    sscc = sscc,
                    boxCount = boxCount,
                    itemCount = itemCount,
                    productName = product.name,
                    productPrintName = product.printName,
                    gtin14 = product.gtin14,
                    egaisCode = null,
                    shelfLifeDays = product.shelfLifeDays,
                    operatorName = null,
                    counterpartyName = null,
                    closedAt = closedAt,
                    productionDate = uniform,
                    shiftNumber = null,
                )
            },
            omitDates = uniform == null,
        )
    }

    /** The operator looked at the printer and says the label is there. Nothing is sent. */
    suspend fun resolveUnknownAsPrinted(palletId: String) = db.recovery.commit { resolveUnknownAsPrintedOwned(palletId) }

    private suspend fun resolveUnknownAsPrintedOwned(palletId: String) =
        pallets.setPrintState(palletId, PalletPrint.PRINTED, null)

    /**
     * Set aside for later, so a dead printer does not stop the line.
     *
     * Keeps whatever reason the last attempt gave, same as `BoxPrinter.defer`:
     * erasing it would leave the queue saying only that the label did not
     * print, which is both less useful and untrue.
     */
    suspend fun defer(palletId: String) = db.recovery.commit { deferOwned(palletId) }

    private suspend fun deferOwned(palletId: String) {
        val row = db.palletDao().get(palletId) ?: return
        if (row.printState == PalletPrint.UNKNOWN) return
        pallets.setPrintState(palletId, PalletPrint.DEFERRED, row.printReason)
    }

    private suspend fun fail(palletId: String, reason: String): PrintOutcome.Failed = db.recovery.commit { failOwned(palletId, reason) }

    private suspend fun failOwned(palletId: String, reason: String): PrintOutcome.Failed {
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
