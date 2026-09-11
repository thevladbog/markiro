package app.markiro.handheld.core.box

import app.markiro.handheld.core.storage.BoxEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.util.Iso
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.UUID

/** Print states a box row can hold. Stored as text so a migration never has to renumber them. */
object BoxPrint {
    const val PENDING = "pending"
    const val PRINTING = "printing"
    const val PRINTED = "printed"
    const val FAILED = "failed"

    /** The bytes may or may not have reached the printer. Only a person resolves this. */
    const val UNKNOWN = "unknown"
    const val DEFERRED = "deferred"
}

/** The device's boxes. One box is open per shift at a time. */
class BoxRepository(
    private val db: HandheldDatabase,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val mutex = Mutex()

    /**
     * The shift's open box, opening one if none is.
     *
     * Serialised so two scans arriving together cannot each open a box and
     * leave the shift with two open ones, which no later query could tell apart.
     */
    suspend fun currentBox(shiftId: String): BoxEntity = mutex.withLock {
        db.boxDao().open(shiftId) ?: BoxEntity(
            boxId = UUID.randomUUID().toString(),
            shiftId = shiftId,
            sscc = null,
            openedAt = Iso.format(clock()),
            closedAt = null,
            operatorId = null,
            printState = BoxPrint.PENDING,
            printReason = null,
            ackedAt = null,
        ).also { db.boxDao().insert(it) }
    }

    fun observeOpen(shiftId: String): Flow<BoxEntity?> = db.boxDao().observeOpen(shiftId)

    suspend fun get(boxId: String): BoxEntity? = db.boxDao().get(boxId)

    suspend fun itemCount(boxId: String): Int = db.boxDao().itemCount(boxId)

    fun observeItemCount(boxId: String): Flow<Int> = db.boxDao().observeItemCount(boxId)

    /**
     * The box's display number within its shift.
     *
     * Derived from persisted rows rather than counted in memory, so a restart
     * cannot reset the floor aid, and deliberately unrelated to the SSCC, so it
     * costs no serial.
     */
    suspend fun ordinal(box: BoxEntity): Int = db.boxDao().ordinal(box.shiftId, box.openedAt, box.boxId)

    fun observeUnprinted(): Flow<List<BoxEntity>> = db.boxDao().observeUnprinted()

    fun observeUnprintedCount(): Flow<Int> = db.boxDao().observeUnprintedCount()

    suspend fun closedCount(shiftId: String): Int = db.boxDao().closedCount(shiftId)

    suspend fun setPrintState(boxId: String, state: String, reason: String?) =
        db.boxDao().setPrintState(boxId, state, reason)

    /**
     * Called once at startup. Anything left mid-print is unknown, never resumed:
     * the app died between handing bytes to the printer and hearing back, and
     * resuming would be an automatic resend of a label that may already be on
     * a box the server has accepted.
     */
    suspend fun demoteInterruptedPrints(): Int = db.boxDao().demoteInterruptedPrints()
}
