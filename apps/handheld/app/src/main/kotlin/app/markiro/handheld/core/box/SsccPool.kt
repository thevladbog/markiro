package app.markiro.handheld.core.box

import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.SsccRangeEntity
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * A block exactly as the server describes it in the shift bundle.
 *
 * `fromSerial`/`toSerial` are the block's ORIGINAL bounds even on a repeat
 * fetch — never shrunk to the unconsumed remainder — and
 * `consumedThroughSerial` is the highest serial the server has recorded as
 * used, or null before any is.
 */
data class ServerRange(
    val issuerPrefix: String,
    val extensionDigit: Int,
    val fromSerial: Long,
    val toSerial: Long,
    val consumedThroughSerial: Long?,
)

/**
 * This device's own serial ranges.
 *
 * Port of `apps/station/src/lib/sscc-pool.ts` with one deliberate difference in
 * mechanism. The station burns in a single `UPDATE ... RETURNING`, because
 * `tauri-plugin-sql` hands each call whatever pooled connection is free, so a
 * SELECT followed by an UPDATE can give one serial to two callers. The handheld
 * cannot copy that — `minSdk = 28` means SQLite 3.22 and `RETURNING` arrived in
 * 3.35 — and does not need to: Room gives a real transaction, so the guarantee
 * is a mutex around one. The rule is what carries over, not the mechanism, and
 * the rule is that two boxes must never share an SSCC.
 */
class SsccPool(private val db: HandheldDatabase) {
    private val mutex = Mutex()

    /**
     * Idempotent and progress-preserving.
     *
     * The primary key turns a replay of a block already held into an update of
     * that same row rather than a second, overlapping one, and `MAX` makes the
     * update safe in both directions: it never regresses a cursor that has
     * advanced locally, and it advances one that is behind what the server
     * knows was consumed. The second half is what stops a device whose database
     * was lost or restored from a stale copy from reissuing serials that are
     * already on printed labels.
     */
    suspend fun addRange(range: ServerRange) = db.recovery.commit { addRangeOwned(range) }

    private suspend fun addRangeOwned(range: ServerRange) = mutex.withLock {
        val dao = db.ssccPoolDao()
        val seeded = range.consumedThroughSerial?.plus(1) ?: range.fromSerial
        db.recovery.commit {
            dao.insertIgnore(
                SsccRangeEntity(
                    issuerPrefix = range.issuerPrefix,
                    extensionDigit = range.extensionDigit,
                    fromSerial = range.fromSerial,
                    toSerial = range.toSerial,
                    nextSerial = seeded,
                ),
            )
            dao.advance(range.issuerPrefix, range.extensionDigit, range.fromSerial, seeded)
        }
    }

    /**
     * Deletes revoked blocks rather than exhausting them.
     *
     * `burn` picks the lowest `fromSerial` that still has room, so a revoked
     * block left in place keeps winning over the replacement an admin just cut,
     * and the reseeded number would never reach a label.
     */
    suspend fun dropRanges(issuerPrefix: String, extensionDigit: Int, fromSerials: List<Long>) = db.recovery.commit { dropRangesOwned(issuerPrefix, extensionDigit, fromSerials) }

    private suspend fun dropRangesOwned(issuerPrefix: String, extensionDigit: Int, fromSerials: List<Long>) {
        if (fromSerials.isEmpty()) return
        mutex.withLock { db.ssccPoolDao().drop(issuerPrefix, extensionDigit, fromSerials) }
    }

    /**
     * The lowest unspent serial, or null when the pool is dry.
     *
     * The read and the cursor advance are one transaction, which is what stops
     * two callers receiving one serial. The mutex around it is belt and braces:
     * measured by removing it, `concurrentBurnsNeverIssueOneSerialTwice` still
     * passes, because Room runs transactions over a single writable connection
     * and the second `beginTransaction` waits. It is kept because the cost of
     * being wrong here is two boxes sharing an SSCC, which the server cannot
     * repair — but no test proves it load-bearing, so do not read one as doing so.
     */
    suspend fun burn(issuerPrefix: String, extensionDigit: Int): Long? = db.recovery.commit { burnOwned(issuerPrefix, extensionDigit) }

    private suspend fun burnOwned(issuerPrefix: String, extensionDigit: Int): Long? = mutex.withLock {
        val dao = db.ssccPoolDao()
        db.recovery.commit {
            val range = dao.lowestWithRoom(issuerPrefix, extensionDigit) ?: return@commit null
            dao.setCursor(issuerPrefix, extensionDigit, range.fromSerial, range.nextSerial + 1)
            range.nextSerial
        }
    }

    suspend fun remaining(issuerPrefix: String, extensionDigit: Int): Long =
        db.ssccPoolDao().remaining(issuerPrefix, extensionDigit)

    companion object {
        /** Boxes. Pallets use 1, and the two must never mix in one range. */
        const val BOX_EXTENSION_DIGIT = 0

        /** Pallets. See BOX_EXTENSION_DIGIT. */
        const val PALLET_EXTENSION_DIGIT = 1
    }
}
