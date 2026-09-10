package app.markiro.handheld.feature.inventory

import app.markiro.handheld.R
import app.markiro.handheld.core.design.Tone
import app.markiro.handheld.core.inventory.InventoryVerdict
import app.markiro.handheld.core.signal.SignalKind

fun InventoryVerdict.label(): Int = when (this) {
    InventoryVerdict.EXPECTED -> R.string.inventory_verdict_expected
    InventoryVerdict.PROTECTED -> R.string.inventory_verdict_protected
    InventoryVerdict.KNOWN_INELIGIBLE -> R.string.inventory_verdict_ineligible
    InventoryVerdict.UNKNOWN -> R.string.inventory_verdict_unknown
    InventoryVerdict.DUPLICATE -> R.string.inventory_verdict_duplicate
    InventoryVerdict.INVALID -> R.string.inventory_verdict_invalid
}

fun InventoryVerdict.tone(): Tone = when (this) {
    InventoryVerdict.EXPECTED -> Tone.Ok
    InventoryVerdict.DUPLICATE, InventoryVerdict.PROTECTED -> Tone.Warn
    InventoryVerdict.KNOWN_INELIGIBLE, InventoryVerdict.UNKNOWN, InventoryVerdict.INVALID -> Tone.Err
}

fun InventoryVerdict.signal(): SignalKind = when (this) {
    InventoryVerdict.EXPECTED -> SignalKind.OK
    InventoryVerdict.DUPLICATE -> SignalKind.DUPLICATE
    else -> SignalKind.ERROR
}

fun statusLabel(status: String): Int = when (status) {
    "EMITTED" -> R.string.inventory_status_emitted
    "INTRODUCED" -> R.string.inventory_status_introduced
    "APPLIED" -> R.string.inventory_status_applied
    "RETIRED" -> R.string.inventory_status_retired
    "WRITTEN_OFF" -> R.string.inventory_status_written_off
    else -> R.string.inventory_status_disaggregation
}

/** `2026-08-20` → `20.08.2026`, the same numeric form in both languages. */
fun civilDate(iso: String): String = iso.split("-").let { if (it.size == 3) "${it[2]}.${it[1]}.${it[0]}" else iso }
