package app.markiro.handheld.core.box

import app.markiro.handheld.core.label.LabelField
import java.time.DateTimeException
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeParseException
import java.util.Locale

/**
 * Port of `packages/domain/src/labels/box-label.ts`, pinned by
 * `box-label-fixtures.json`.
 *
 * Every function here is tolerant on purpose, exactly like the source: a label
 * must never fail to print because of a date, so a malformed one becomes an
 * empty field rather than an exception.
 */
data class BoxLabelInput(
    val sscc: String,
    val itemCount: Int,
    val productName: String,
    /** The catalog's short print name; null falls back to `productName`. */
    val productPrintName: String?,
    val gtin14: String,
    val egaisCode: String?,
    val shelfLifeDays: Int?,
    val operatorName: String?,
    val counterpartyName: String?,
    /** The stored UTC instant of the box's own closure. */
    val closedAt: String,
    val productionDate: String?,
    val shiftNumber: String?,
)

private val ISO_DATE = Regex("^(\\d{4})-(\\d{2})-(\\d{2})$")

/**
 * `YYYY-MM-DD` in ASCII digits whatever the device's locale is.
 *
 * `String.format` without a locale uses the default one, and a locale with
 * non-Western numerals renders `%02d` in its own digits — which this module's
 * own `ISO_DATE` would then reject, and a printed label would carry digits the
 * receiver cannot read.
 */
private fun formatIso(year: Int, month: Int, day: Int): String =
    String.format(Locale.ROOT, "%04d-%02d-%02d", year, month, day)

/**
 * Plain calendar-day addition on a `YYYY-MM-DD` string — no timezone is
 * involved at any point, so a daylight-saving transition inside the window can
 * never shift the printed day by one.
 *
 * Returns "" for a malformed or non-existent date such as `2026-02-30`.
 */
fun addCalendarDays(isoDate: String, days: Int): String {
    val match = ISO_DATE.matchEntire(isoDate) ?: return ""
    val (year, month, day) = match.destructured
    val yearNumber = year.toInt()
    if (yearNumber < 1 || yearNumber > 9999) return ""
    val moved = try {
        LocalDate.of(yearNumber, month.toInt(), day.toInt()).plusDays(days.toLong())
    } catch (_: DateTimeException) {
        // Covers both a date that does not exist and an addition that runs off
        // the supported range; the source rejects the same two cases.
        return ""
    } catch (_: ArithmeticException) {
        return ""
    }
    if (moved.year < 1 || moved.year > 9999) return ""
    return formatIso(moved.year, moved.monthValue, moved.dayOfMonth)
}

/**
 * Last usable calendar day, inclusive: the production day is day one, so
 * 2026-09-10 with 365 days expires on 2027-09-09.
 */
fun shelfLifeExpiryDate(productionDate: String, shelfLifeDays: Int?): String {
    if (shelfLifeDays == null || shelfLifeDays <= 0) return ""
    return addCalendarDays(productionDate, shelfLifeDays - 1)
}

/** `YYYY-MM-DD` → `DD.MM.YYYY`; anything else is returned unchanged. */
fun formatLabelDate(isoDate: String): String {
    val match = ISO_DATE.matchEntire(isoDate) ?: return isoDate
    val (year, month, day) = match.destructured
    return "$day.$month.$year"
}

/**
 * The LOCAL calendar date of a stored UTC instant.
 *
 * Storage keeps every timestamp in UTC and devices show local dates. A box
 * label is read by a person standing next to the terminal that printed it, so
 * the day it carries is that terminal's own day.
 */
fun localIsoDate(instant: String, zone: ZoneId = ZoneId.systemDefault()): String {
    val parsed = try {
        Instant.parse(instant)
    } catch (_: DateTimeParseException) {
        return ""
    }
    val date = parsed.atZone(zone).toLocalDate()
    return formatIso(date.year, date.monthValue, date.dayOfMonth)
}

/**
 * The declared production date when present, otherwise the box's local close
 * date. An invalid declared date returns "" rather than falling back and hiding
 * corrupt data.
 */
fun effectiveProductionIsoDate(
    closedAt: String,
    productionDate: String?,
    zone: ZoneId = ZoneId.systemDefault(),
): String = if (productionDate != null) addCalendarDays(productionDate, 0) else localIsoDate(closedAt, zone)

/**
 * The field record a box label is rendered from.
 *
 * `sscc` is the BARE 18 digits: the `(00)` application identifier is added by
 * the emitter and nowhere else, because storing or transporting it gets an
 * export to «Честный знак» rejected.
 */
fun boxLabelFields(input: BoxLabelInput, zone: ZoneId = ZoneId.systemDefault()): Map<LabelField, String> {
    val effectiveDate = effectiveProductionIsoDate(input.closedAt, input.productionDate, zone)
    val effectiveExpiry = shelfLifeExpiryDate(effectiveDate, input.shelfLifeDays)
    return mapOf(
        LabelField.PRODUCT_NAME to input.productName,
        LabelField.PRODUCT_PRINT_NAME to (input.productPrintName ?: input.productName),
        LabelField.PRODUCT_GTIN to input.gtin14,
        LabelField.PRODUCT_EGAIS to (input.egaisCode ?: ""),
        LabelField.KM_CODE to "",
        LabelField.SSCC to input.sscc,
        LabelField.SHIFT_NO to (input.shiftNumber ?: ""),
        LabelField.DATE to formatLabelDate(effectiveDate),
        LabelField.EXPIRY to formatLabelDate(effectiveExpiry),
        LabelField.QTY to input.itemCount.toString(),
        LabelField.OPERATOR to (input.operatorName ?: ""),
        LabelField.COUNTERPARTY_NAME to (input.counterpartyName ?: ""),
    )
}
