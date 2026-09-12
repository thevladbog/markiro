package app.markiro.handheld.core.storage

import app.markiro.handheld.core.network.ValidationOccurrenceReceipt

/** Exact occurrence identity; pending preserves last accepted context, conflict is monotonic. */
suspend fun HandheldDatabase.applyValidationReceipt(receipt: ValidationOccurrenceReceipt) = recovery.commit {
    val row = validationDao().get(receipt.shiftId, receipt.codeHash) ?: return@commit
    if (row.scannedAt != receipt.scannedAt || row.deviceId != recovery.token().owner.deviceId || row.outcome == "conflict") return@commit
    if (receipt.outcome !in setOf("first_accepted", "reprocessed", "pending", "conflict")) return@commit
    // Released is a durable no-future-projection tombstone, not fabricated print/receipt evidence.
    if (row.lastReceipt == "released" && receipt.outcome != "conflict") return@commit
    if (receipt.ownership == "released") {
        codeDao().deleteExact(row.shiftId,row.codeHash,row.scannedAt)
        validationDao().update(row.copy(outcome="first_accepted",kind="first_accepted",lastReceipt="released",originalProjected=true))
        return@commit
    }
    when (receipt.outcome) {
        "conflict", "reprocessed" -> codeDao().deleteExact(row.shiftId, row.codeHash, row.scannedAt)
        "first_accepted" -> if (!row.originalProjected) {
            // A first authoritative receipt may correct a tentative repeat after source release.
            // An old first receipt replay must never resurrect an explicitly released original.
            val existing = codeDao().get(row.codeHash)
            if (existing == null || existing.shiftId == row.sourceShiftId) {
                if (existing != null) codeDao().deleteExact(existing.shiftId, existing.codeHash, existing.scannedAt)
                codeDao().insert(CodeEntity(row.codeHash, row.shiftId, row.gtin14, row.serial, row.scannedAt))
            }
        }
    }
    validationDao().update(row.copy(
        outcome = receipt.outcome,
        kind = if (receipt.outcome in setOf("first_accepted", "reprocessed")) receipt.outcome else row.kind,
        lastReceipt = if (receipt.outcome == "pending") row.lastReceipt else receipt.outcome,
        originalProjected = row.originalProjected || receipt.outcome == "first_accepted",
    ))
}
