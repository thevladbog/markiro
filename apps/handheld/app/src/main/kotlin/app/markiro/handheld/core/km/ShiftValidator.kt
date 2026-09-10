package app.markiro.handheld.core.km

/** Wire values of `POST /station/scans` items. */
enum class Verdict(val wire: String) {
    OK("ok"),
    DUPLICATE("duplicate"),
    WRONG_GTIN("wrong_gtin"),
    INVALID("invalid"),
    ;

    companion object {
        fun fromWire(value: String): Verdict = entries.first { it.wire == value }
    }
}

/** Everything known before the journal is consulted; `Km` still needs the duplicate check. */
sealed interface Classification {
    data class Km(val km: ParsedKm, val hash: String) : Classification
    data class WrongGtin(val km: ParsedKm, val expectedGtin14: String) : Classification
    data class Invalid(val code: String) : Classification
}

/** Port of packages/domain/src/scan/validate.ts: invalid → wrong_gtin → duplicate → ok. */
object ShiftValidator {
    fun classify(raw: String, expectedGtin14: String): Classification {
        val km = try {
            KmCodec.canonicalize(raw)
        } catch (e: KmException) {
            return Classification.Invalid(e.code)
        }
        if (km.gtin14 != expectedGtin14) return Classification.WrongGtin(km, expectedGtin14)
        return Classification.Km(km, KmCodec.hash(km))
    }

    fun verdict(raw: String, expectedGtin14: String, isDuplicate: (String) -> Boolean): Verdict =
        when (val c = classify(raw, expectedGtin14)) {
            is Classification.Invalid -> Verdict.INVALID
            is Classification.WrongGtin -> Verdict.WRONG_GTIN
            is Classification.Km -> if (isDuplicate(c.hash)) Verdict.DUPLICATE else Verdict.OK
        }
}
