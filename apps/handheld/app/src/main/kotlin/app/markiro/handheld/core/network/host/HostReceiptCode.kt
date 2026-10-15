package app.markiro.handheld.core.network.host

/** What a person should be told about a `rejected` receipt (spec 8.5, point 2). */
enum class RejectionHint {
    /** The shift is closed, unknown to the host, or another device works it. */
    OTHER_DEVICE_OR_CLOSED,

    /** The same id came with other content: a defect of this app, for support. */
    BUG,

    /** The license has no pallets feature. */
    LICENSE,

    /** A box stands on another pallet (`details.palletSscc`, `details.palletId`). */
    PALLET_CONFLICT,

    /** Any other refusal of the record's data. */
    DATA,
}

/** `markiro_proto::receipt_codes`, in the order of `fact-receipt-codes.json`. A code a newer host adds is `DATA`, never a failure of the batch. */
object HostReceiptCode {
    val ALL: List<String> = listOf(
        "invalid_record", "payload_mismatch", "unknown_shift", "not_entered", "gtin_mismatch", "box_unknown",
        "box_closed", "box_already_closed", "box_state", "sscc_not_issued", "sscc_taken", "no_pallets",
        "pallet_unknown", "pallet_already_closed", "pallet_state", "subject_unknown", "box_not_found",
        "box_not_closed", "box_on_pallet", "product_mismatch", "pallet_not_open", "pallet_count_mismatch",
        "feature_disabled",
    )

    fun hintOf(code: String?): RejectionHint = when (code) {
        "not_entered", "unknown_shift" -> RejectionHint.OTHER_DEVICE_OR_CLOSED
        "payload_mismatch" -> RejectionHint.BUG
        "feature_disabled" -> RejectionHint.LICENSE
        "box_on_pallet" -> RejectionHint.PALLET_CONFLICT
        else -> RejectionHint.DATA
    }
}
