package app.markiro.handheld.core.duplicate

import app.markiro.handheld.core.box.BoxLabelInput
import app.markiro.handheld.core.box.boxLabelFields
import app.markiro.handheld.core.label.LabelField
import app.markiro.handheld.core.storage.ShiftEntity

/**
 * A duplicate's label data.
 *
 * It shares the box label's calendar and naming rules -- same product, same
 * shift, same inclusive expiry -- and differs in exactly three fields: it
 * carries the marking code, it is one item, and it has no SSCC.
 *
 * `acceptedAt` stands where the box label puts `closedAt`, so a reprint the next
 * morning still prints the day the unit was accepted rather than the day it was
 * reprinted. The bytes are replayed anyway, which makes this belt and braces --
 * but the two must not disagree if a future path ever re-renders.
 */
fun duplicateLabelFields(
    shift: ShiftEntity,
    canonicalRaw: String,
    acceptedAt: String,
    operatorName: String?,
): Map<LabelField, String> {
    val km = parseDuplicateKm(canonicalRaw)
    val base = boxLabelFields(
        BoxLabelInput(
            sscc = "",
            itemCount = 1,
            productName = shift.productName.orEmpty(),
            productPrintName = shift.productPrintName,
            gtin14 = shift.productGtin14.orEmpty(),
            egaisCode = shift.egaisCode,
            shelfLifeDays = shift.shelfLifeDays,
            operatorName = operatorName,
            counterpartyName = shift.counterpartyName,
            closedAt = acceptedAt,
            productionDate = shift.productionDate,
            shiftNumber = shift.number,
        ),
    )
    return base + mapOf(
        LabelField.KM_CODE to km.canonicalRaw,
        LabelField.QTY to "1",
        LabelField.SSCC to "",
    )
}
