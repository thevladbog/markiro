package app.markiro.handheld.core.scan

import android.database.sqlite.SQLiteConstraintException
import androidx.room.withTransaction
import app.markiro.handheld.core.km.Classification
import app.markiro.handheld.core.km.ParsedKm
import app.markiro.handheld.core.km.ShiftValidator
import app.markiro.handheld.core.km.Verdict
import app.markiro.handheld.core.storage.CodeEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.OutboxEntity
import app.markiro.handheld.core.storage.ScanEventEntity
import app.markiro.handheld.core.storage.ShiftEntity
import app.markiro.handheld.core.util.Iso
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

data class ScanOutcome(
    val verdict: Verdict,
    val km: ParsedKm?,
    val hash: String?,
    /** For duplicates: when the code was first accepted on this device. */
    val firstSeenAt: String?,
    val scannedAt: String,
)

/**
 * Same rules as the station's `recordScan`: one scan at a time, the code row first (its primary
 * key turns a lost race into a `duplicate`), then the journal event, then the outbox row.
 * Room gives us a real transaction, so a failure leaves nothing behind.
 */
class ScanRecorder(private val db: HandheldDatabase, private val clock: () -> Long = System::currentTimeMillis) {
    private val mutex = Mutex()

    /**
     * `boxId` names the transport box this scan belongs to, or null outside an
     * aggregation shift. It reaches the code row and the outbox row only on an
     * ACCEPTED scan: a box counts what it actually holds, and the server rejects
     * a `boxId` without an accepted code.
     */
    suspend fun record(
        shift: ShiftEntity,
        raw: String,
        operatorId: String?,
        boxId: String? = null,
    ): ScanOutcome = mutex.withLock {
        val expectedGtin = checkNotNull(shift.productGtin14) { "shift ${shift.id} has no bundle" }
        val scannedAt = Iso.format(clock())
        db.withTransaction {
            when (val c = ShiftValidator.classify(raw, expectedGtin)) {
                is Classification.Invalid -> {
                    write(shift.id, raw, Verdict.INVALID, scannedAt, operatorId, null, null, null)
                    ScanOutcome(Verdict.INVALID, null, null, null, scannedAt)
                }
                is Classification.WrongGtin -> {
                    write(shift.id, raw, Verdict.WRONG_GTIN, scannedAt, operatorId, null, null, null)
                    ScanOutcome(Verdict.WRONG_GTIN, c.km, null, null, scannedAt)
                }
                is Classification.Km -> {
                    var verdict = Verdict.OK
                    var firstSeen: String? = null
                    val existing = db.codeDao().get(c.hash)
                    if (existing != null) {
                        verdict = Verdict.DUPLICATE
                        firstSeen = existing.scannedAt
                    } else {
                        try {
                            db.codeDao().insert(CodeEntity(c.hash, shift.id, c.km.gtin14, c.km.serial, scannedAt, boxId))
                        } catch (_: SQLiteConstraintException) {
                            verdict = Verdict.DUPLICATE
                            firstSeen = db.codeDao().get(c.hash)?.scannedAt
                        }
                    }
                    val accepted = verdict == Verdict.OK
                    write(
                        shift.id, raw, verdict, scannedAt, operatorId,
                        if (accepted) c.km else null, if (accepted) c.hash else null, if (accepted) boxId else null,
                    )
                    ScanOutcome(verdict, c.km, c.hash, firstSeen, scannedAt)
                }
            }
        }
    }

    private suspend fun write(
        shiftId: String,
        raw: String,
        verdict: Verdict,
        scannedAt: String,
        operatorId: String?,
        km: ParsedKm?,
        hash: String?,
        boxId: String?,
    ) {
        db.scanEventDao().insert(
            ScanEventEntity(shiftId = shiftId, raw = raw, verdict = verdict.wire, scannedAt = scannedAt, operatorId = operatorId, codeHash = hash),
        )
        db.outboxDao().insert(
            OutboxEntity(
                shiftId = shiftId,
                raw = raw,
                verdict = verdict.wire,
                scannedAt = scannedAt,
                operatorId = operatorId,
                codeHash = hash,
                gtin14 = km?.gtin14,
                serial = km?.serial,
                boxId = boxId,
            ),
        )
    }
}
