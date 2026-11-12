package app.markiro.handheld.core.sets

import app.markiro.handheld.core.km.KmCodec
import app.markiro.handheld.core.km.KmException
import app.markiro.handheld.core.km.ParsedKm
import app.markiro.handheld.core.network.SetItemDto

enum class SetScanStatus { INCOMPLETE, ITEM_ADDED, CLOSED, EXTRA, DUPLICATE, WRONG_PRODUCT, INVALID, TOO_LARGE }

data class SetScanResult(
    val status: SetScanStatus,
    val items: List<String>,
    val remaining: Int,
    val setCode: ParsedKm? = null,
)

internal fun setCodeOrNull(raw: String): ParsedKm? = try {
    KmCodec.canonicalize(raw)
} catch (_: KmException) {
    null
}

fun judgeSetScan(
    kitGtin: String,
    recipe: List<SetItemDto>,
    draft: List<String>,
    raw: String,
    alreadyUsed: Set<String>,
): SetScanResult {
    val parsed = draft.mapNotNull(::setCodeOrNull)
    val counts = parsed.groupingBy { it.gtin14 }.eachCount()
    val missing = recipe.sumOf { (it.quantity - counts.getOrDefault(it.gtin14, 0)).coerceAtLeast(0) }
    fun unchanged(status: SetScanStatus) = SetScanResult(status, draft, missing)
    val code = setCodeOrNull(raw) ?: return unchanged(SetScanStatus.INVALID)
    val hash = KmCodec.hash(code)
    val used = parsed.map(KmCodec::key)
    if (hash in alreadyUsed || KmCodec.key(code) in used) return unchanged(SetScanStatus.DUPLICATE)
    if (code.gtin14 == kitGtin) {
        if (missing != 0) return unchanged(SetScanStatus.INCOMPLETE)
        if (used.toSet().size != used.size || (alreadyUsed.isNotEmpty() && parsed.any { KmCodec.hash(it) in alreadyUsed })) return unchanged(SetScanStatus.DUPLICATE)
        if (parsed.size != draft.size || draft.size != recipe.sumOf { it.quantity }) return unchanged(SetScanStatus.INVALID)
        return SetScanResult(SetScanStatus.CLOSED, draft, 0, code)
    }
    val item = recipe.firstOrNull { it.gtin14 == code.gtin14 } ?: return unchanged(SetScanStatus.WRONG_PRODUCT)
    if (counts.getOrDefault(code.gtin14, 0) >= item.quantity) return unchanged(SetScanStatus.EXTRA)
    return SetScanResult(SetScanStatus.ITEM_ADDED, draft + code.canonicalRaw, missing - 1)
}
