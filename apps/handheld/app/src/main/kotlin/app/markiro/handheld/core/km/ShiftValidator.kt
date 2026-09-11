package app.markiro.handheld.core.km

/** Wire values of `POST /station/scans` items. */
enum class Verdict(val wire: String) {
    OK("ok"),
    DUPLICATE("duplicate"),
    WRONG_GTIN("wrong_gtin"),
    INVALID("invalid"),

    /**
     * Not a scan outcome: the journal's record that an accepted scan was taken
     * back. Written by the exception engine, never by the validator, and it
     * exists here because the feed renders every journal row through this enum.
     */
    UNDONE("undone"),
    ;

    companion object {
        /**
         * Null for a verdict this build does not know.
         *
         * `entries.first` threw, and the one caller is a Compose feed that
         * renders whatever the journal holds -- so an unknown verdict took the
         * work screen down on the main thread rather than showing one odd row.
         * A device can always meet a row written by a newer build after a
         * downgrade, and a scan journal is not worth a crash.
         */
        fun fromWireOrNull(value: String): Verdict? = entries.firstOrNull { it.wire == value }
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
