package app.markiro.handheld.core.scan

import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.ShiftEntity
import app.markiro.handheld.core.storage.ValidationHistoryEntity

enum class ValidationRefusal { SAME_SHIFT, PREVIOUS_DISALLOWED, OTHER_ACTIVE, CLOSURE_UNKNOWN }
data class ValidationAdmission(val refusal: ValidationRefusal? = null, val source: ValidationHistoryEntity? = null)

/** Called within the recorder's Room/recovery transaction, before a job may start. */
suspend fun validationAdmission(db: HandheldDatabase, shift: ShiftEntity, hash: String): ValidationAdmission {
    val dao = db.validationDao()
    val original = db.codeDao().get(hash)
    val history = dao.history(shift.id, hash)
    if (dao.get(shift.id, hash) != null || original?.shiftId == shift.id || history.any { it.shiftId == shift.id }) {
        return ValidationAdmission(ValidationRefusal.SAME_SHIFT)
    }
    val source = history.firstOrNull { it.kind == "original" }
    if (dao.otherActive(shift.id, hash, source?.takeIf { it.shiftStatus == "closed" }?.shiftId) || history.any { it.shiftId != shift.id && it.shiftStatus != "closed" }) {
        return ValidationAdmission(ValidationRefusal.OTHER_ACTIVE)
    }
    if (source != null || original != null) {
        if (!shift.allowPreviouslyAcceptedCodes) return ValidationAdmission(ValidationRefusal.PREVIOUS_DISALLOWED)
        if (source == null || source.shiftStatus != "closed" || (original != null && original.shiftId != source.shiftId)) {
            return ValidationAdmission(ValidationRefusal.CLOSURE_UNKNOWN)
        }
    }
    // Absence in even a complete snapshot is not proof of uniqueness: every acceptance is pending.
    return ValidationAdmission(source = source)
}
