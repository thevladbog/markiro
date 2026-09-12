package app.markiro.handheld.core.box

import app.markiro.handheld.core.label.LabelField
import java.time.ZoneId

/**
 * Port of `packages/domain/src/labels/pallet-label.ts`, pinned by
 * `box-label-fixtures.json`'s `palletFields` (the fixture itself lives beside
 * the box-label one in `packages/domain/src/labels/box-label-fixtures.ts`,
 * since a pallet's date arithmetic is the SAME shared rule under a different
 * field builder, not a second one to pin independently).
 *
 * Lives beside `BoxLabelFields.kt` and reuses its date functions for the
 * reason the TypeScript source gives: the station and the handheld both close
 * pallets, and one label rule owned by two apps is exactly what the root
 * `AGENTS.md` forbids re-implementing independently.
 *
 * The only real difference from a box: `qty` stays PRODUCT UNITS and
 * `qty.boxes` carries the box count, so a clerk counting boxes at goods-in
 * never reads a units figure by mistake. A pallet carries no unit marking
 * code, so `km.code` is always empty, exactly like a box.
 */
data class PalletLabelInput(
    /**
     * The BARE 18 digits. The `(00)` application identifier is added by the
     * emitter and nowhere else: storing or transporting it gets an export to
     * «Честный знак» rejected.
     */
    val sscc: String,
    val boxCount: Int,
    /** Units across the pallet's boxes, excluding displaced and removed items. */
    val itemCount: Int,
    val productName: String,
    /** The catalog's short print name; null falls back to `productName`. */
    val productPrintName: String?,
    val gtin14: String,
    val egaisCode: String?,
    val shelfLifeDays: Int?,
    val operatorName: String?,
    val counterpartyName: String?,
    /**
     * The pallet's OWN closure moment, persisted: a recovery print the next
     * morning reads it back and stamps the same two dates rather than that
     * morning's.
     */
    val closedAt: String,
    val productionDate: String?,
    /** `AUG26-003/S`; null when the mirror predates the shift-number sync. */
    val shiftNumber: String?,
)

/**
 * The field record a pallet label is rendered from.
 *
 * `boxLabelFields` in `BoxLabelFields.kt` computes the shared date fields
 * through the exact same `effectiveProductionIsoDate` / `shelfLifeExpiryDate`
 * / `formatLabelDate` functions this reuses, so the two field builders can
 * never disagree about «Дата производства» or «Годен до».
 */
fun palletLabelFields(input: PalletLabelInput, zone: ZoneId = ZoneId.systemDefault()): Map<LabelField, String> {
    val effectiveDate = effectiveProductionIsoDate(input.closedAt, input.productionDate, zone)
    val effectiveExpiry = shelfLifeExpiryDate(effectiveDate, input.shelfLifeDays)
    return mapOf(
        LabelField.PRODUCT_NAME to input.productName,
        LabelField.PRODUCT_PRINT_NAME to (input.productPrintName ?: input.productName),
        LabelField.PRODUCT_GTIN to input.gtin14,
        LabelField.PRODUCT_EGAIS to (input.egaisCode ?: ""),
        // A pallet is not a unit and carries no marking code.
        LabelField.KM_CODE to "",
        LabelField.SSCC to input.sscc,
        LabelField.SHIFT_NO to (input.shiftNumber ?: ""),
        LabelField.DATE to formatLabelDate(effectiveDate),
        LabelField.EXPIRY to formatLabelDate(effectiveExpiry),
        LabelField.QTY to input.itemCount.toString(),
        LabelField.QTY_BOXES to input.boxCount.toString(),
        LabelField.OPERATOR to (input.operatorName ?: ""),
        LabelField.COUNTERPARTY_NAME to (input.counterpartyName ?: ""),
    )
}
