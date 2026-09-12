package app.markiro.handheld.core.exceptions

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * One operator correction, in the only four shapes the server accepts.
 *
 * A sealed hierarchy rather than one class with four nullable fields, because
 * the server's `superRefine` rejects the WHOLE batch when a fact carries a
 * field its kind forbids, and a rejected batch is retried indefinitely --
 * wedging scans, box closures and shift closure on that device. Making the
 * shape a type removes the class of bug: there is no way to construct a
 * `Clear` that carries a code hash.
 */
sealed interface ExceptionFact {
    val kind: String
    val boxId: String
    val shiftId: String

    /** Informational on the wire: the server always uses the authenticated device. */
    val terminalId: String?
    val operatorId: String?
    val occurredAt: String

    data class Undo(
        override val boxId: String,
        override val shiftId: String,
        override val terminalId: String?,
        override val operatorId: String?,
        override val occurredAt: String,
        val codeHash: String,
        /**
         * The original scan's own `scannedAt`, copied from `codes_mirror`.
         *
         * A JOIN KEY, not a timestamp: the server matches the claim it releases
         * by this exact value. Reading the clock here instead sent a whole
         * slice's events to quarantine once already.
         */
        val targetScannedAt: String,
    ) : ExceptionFact {
        override val kind get() = "undo"
    }

    data class Clear(
        override val boxId: String,
        override val shiftId: String,
        override val terminalId: String?,
        override val operatorId: String?,
        override val occurredAt: String,
    ) : ExceptionFact {
        override val kind get() = "clear"
    }

    data class Disassemble(
        override val boxId: String,
        override val shiftId: String,
        override val terminalId: String?,
        override val operatorId: String?,
        override val occurredAt: String,
        val reason: String,
    ) : ExceptionFact {
        override val kind get() = "disassemble"
    }

    data class Reprint(
        override val boxId: String,
        override val shiftId: String,
        override val terminalId: String?,
        override val operatorId: String?,
        override val occurredAt: String,
        val reason: String,
    ) : ExceptionFact {
        override val kind get() = "reprint"
    }
}

/**
 * Every key, always present, nulls spelled out.
 *
 * Built by hand rather than serialized from a class because the Retrofit
 * converter uses the lenient `Json` (`explicitNulls = false`, see
 * `core/network/NetworkModule.kt`), which DROPS a null-valued field -- and
 * `codeHash`, `reason`, `terminalId` and `operatorId` are declared `.nullable()`
 * WITHOUT `.default()` on the server, so an absent key fails validation for the
 * whole batch. This is the same reason `productLabelEvents` is a list of raw
 * JSON elements.
 */
fun ExceptionFact.toWireJson(): JsonObject {
    val undo = this as? ExceptionFact.Undo
    val reason = when (this) {
        is ExceptionFact.Disassemble -> reason
        is ExceptionFact.Reprint -> reason
        is ExceptionFact.Undo, is ExceptionFact.Clear -> null
    }
    return buildJsonObject {
        put("kind", kind)
        put("boxId", boxId)
        put("codeHash", undo?.codeHash)
        put("targetScannedAt", undo?.targetScannedAt)
        put("shiftId", shiftId)
        put("terminalId", terminalId)
        put("operatorId", operatorId)
        put("reason", reason)
        put("occurredAt", occurredAt)
    }
}

/** The two corrections the server accepts against a closed pallet. */
enum class PalletExceptionKind(val wire: String) {
    /**
     * Taking a pallet apart. No producer on this device yet -- the handheld's
     * pallet-exceptions screen is a later task -- but the storage and sync
     * channel below carry it, because the server's `palletExceptionSchema`
     * accepts exactly these two and a channel that can only express one would
     * have to be reopened to add the other.
     */
    DISASSEMBLE("disassemble"),
    REPRINT("reprint"),
}

/**
 * One operator correction against a closed PALLET.
 *
 * A single class rather than the sealed hierarchy [ExceptionFact] uses, because
 * unlike the box kinds -- which carry different fields and are cross-validated
 * by a server `superRefine` that rejects the whole batch on a wrong shape --
 * both pallet kinds carry the identical field set and differ only in `kind`.
 *
 * `reason` is non-null: `palletExceptionSchema` declares it `z.string().min(1)`
 * for BOTH kinds, unlike the box channel where it is nullable.
 */
data class PalletExceptionFact(
    val kind: PalletExceptionKind,
    val palletId: String,
    val shiftId: String,
    /** Informational on the wire: the server always uses the authenticated device. */
    val terminalId: String?,
    val operatorId: String?,
    val reason: String,
    val occurredAt: String,
)

/**
 * Every key, always present, nulls spelled out -- for the identical reason
 * [ExceptionFact.toWireJson] spells its own out: `terminalId` and `operatorId`
 * are `.nullable()` WITHOUT `.default()` on the server, and the Retrofit
 * converter's lenient `Json` (`explicitNulls = false`, see
 * `core/network/NetworkModule.kt`) DROPS a null-valued field, so an absent key
 * fails validation for the whole batch -- which is then retried forever.
 */
fun PalletExceptionFact.toWireJson(): JsonObject = buildJsonObject {
    put("kind", kind.wire)
    put("palletId", palletId)
    put("shiftId", shiftId)
    put("terminalId", terminalId)
    put("operatorId", operatorId)
    put("reason", reason)
    put("occurredAt", occurredAt)
}

/**
 * The audit text is a WIRE value, not UI copy, so it lives here rather than in
 * `strings.xml`: the server stores exactly this string and the station stores
 * the same Russian wording (`apps/station/src/i18n/ru.json`). A handheld
 * switched to English shows a localized label and still sends the canonical
 * text, so one manager's ledger does not end up half translated.
 */
enum class DisassembleReason(val audit: String) {
    WRONG_PRODUCT("Неверный товар"),
    WRONG_QUANTITY("Неверное количество"),
    DAMAGED_PACKAGE("Упаковка повреждена"),
    QUALITY_REJECTED("Отклонено контролем качества"),
}

enum class ReprintReason(val audit: String) {
    DAMAGED_LABEL("Этикетка повреждена"),
    UNREADABLE_LABEL("Этикетка не читается"),
    PRINTER_JAM("Замятие принтера / нет печати"),
    QUALITY_REQUEST("Запрос контроля качества"),

    /**
     * Never offered in the reason list: written by print recovery when the
     * operator resolves an unknown outcome with «Напечатать ещё раз».
     */
    PRINT_OUTCOME_UNKNOWN("Результат печати неизвестен"),
}
