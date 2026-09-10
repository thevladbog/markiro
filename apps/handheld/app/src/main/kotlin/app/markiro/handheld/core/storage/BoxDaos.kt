package app.markiro.handheld.core.storage

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

@Dao
interface BoxDao {
    @Insert
    suspend fun insert(box: BoxEntity)

    @Query("SELECT * FROM boxes WHERE shiftId = :shiftId AND closedAt IS NULL LIMIT 1")
    suspend fun open(shiftId: String): BoxEntity?

    @Query("SELECT * FROM boxes WHERE shiftId = :shiftId AND closedAt IS NULL LIMIT 1")
    fun observeOpen(shiftId: String): Flow<BoxEntity?>

    @Query("SELECT * FROM boxes WHERE boxId = :boxId")
    suspend fun get(boxId: String): BoxEntity?

    /**
     * Derived, never stored, and correlated by box rather than by shift: a code
     * scanned into a different box must never inflate this one's count.
     */
    @Query("SELECT COUNT(*) FROM codes_mirror WHERE boxId = :boxId")
    suspend fun itemCount(boxId: String): Int

    @Query("SELECT COUNT(*) FROM codes_mirror WHERE boxId = :boxId")
    fun observeItemCount(boxId: String): Flow<Int>

    /**
     * Display-only box number within the shift. Derived from persisted rows so a
     * restart cannot reset the floor aid, and deliberately unrelated to the
     * SSCC so it costs no serial.
     */
    @Query(
        "SELECT COUNT(*) FROM boxes WHERE shiftId = :shiftId AND (openedAt < :openedAt " +
            "OR (openedAt = :openedAt AND boxId <= :boxId))",
    )
    suspend fun ordinal(shiftId: String, openedAt: String, boxId: String): Int

    /** Guarded by `closedAt IS NULL` so a replayed close cannot renumber a box. */
    @Query(
        "UPDATE boxes SET sscc = :sscc, closedAt = :closedAt, operatorId = :operatorId, " +
            "printState = 'pending', printReason = NULL WHERE boxId = :boxId AND closedAt IS NULL",
    )
    suspend fun close(boxId: String, sscc: String, closedAt: String, operatorId: String?): Int

    @Query("UPDATE boxes SET printState = :state, printReason = :reason WHERE boxId = :boxId")
    suspend fun setPrintState(boxId: String, state: String, reason: String?)

    /** Anything the app left mid-print is unknown, never resumable. */
    @Query("UPDATE boxes SET printState = 'unknown', printReason = NULL WHERE printState = 'printing'")
    suspend fun demoteInterruptedPrints(): Int

    /** The deferred-label queue: closed boxes whose label is not resolved, oldest first. */
    @Query("SELECT * FROM boxes WHERE closedAt IS NOT NULL AND printState <> 'printed' ORDER BY closedAt, boxId")
    fun observeUnprinted(): Flow<List<BoxEntity>>

    @Query("SELECT COUNT(*) FROM boxes WHERE closedAt IS NOT NULL AND printState <> 'printed'")
    fun observeUnprintedCount(): Flow<Int>

    @Query("SELECT COUNT(*) FROM boxes WHERE shiftId = :shiftId AND closedAt IS NOT NULL")
    suspend fun closedCount(shiftId: String): Int

    /**
     * Closed and unacknowledged, oldest first, for the sync batch. The ordering
     * is what lets a retry re-read the same first N rows: nothing can close
     * earlier than a box that already closed.
     */
    @Query("SELECT * FROM boxes WHERE closedAt IS NOT NULL AND ackedAt IS NULL ORDER BY closedAt, boxId LIMIT :limit")
    suspend fun unacked(limit: Int): List<BoxEntity>

    @Query("UPDATE boxes SET ackedAt = :at WHERE boxId IN (:boxIds)")
    suspend fun markAcked(boxIds: List<String>, at: String)

    @Query("DELETE FROM boxes")
    suspend fun clear()
}

@Dao
interface SsccPoolDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertIgnore(range: SsccRangeEntity): Long

    /**
     * Never regresses a cursor that has advanced locally, and advances one that
     * is behind what the server knows was consumed — which is what stops a
     * device restored from a stale copy from reissuing serials already printed.
     */
    @Query(
        "UPDATE sscc_pool SET nextSerial = MAX(nextSerial, :nextSerial) " +
            "WHERE issuerPrefix = :issuerPrefix AND extensionDigit = :extensionDigit AND fromSerial = :fromSerial",
    )
    suspend fun advance(issuerPrefix: String, extensionDigit: Int, fromSerial: Long, nextSerial: Long)

    @Query(
        "SELECT * FROM sscc_pool WHERE issuerPrefix = :issuerPrefix AND extensionDigit = :extensionDigit " +
            "AND nextSerial <= toSerial ORDER BY fromSerial LIMIT 1",
    )
    suspend fun lowestWithRoom(issuerPrefix: String, extensionDigit: Int): SsccRangeEntity?

    @Query(
        "UPDATE sscc_pool SET nextSerial = :nextSerial WHERE issuerPrefix = :issuerPrefix " +
            "AND extensionDigit = :extensionDigit AND fromSerial = :fromSerial",
    )
    suspend fun setCursor(issuerPrefix: String, extensionDigit: Int, fromSerial: Long, nextSerial: Long)

    @Query(
        "DELETE FROM sscc_pool WHERE issuerPrefix = :issuerPrefix AND extensionDigit = :extensionDigit " +
            "AND fromSerial IN (:fromSerials)",
    )
    suspend fun drop(issuerPrefix: String, extensionDigit: Int, fromSerials: List<Long>)

    @Query(
        "SELECT COALESCE(SUM(toSerial - nextSerial + 1), 0) FROM sscc_pool WHERE issuerPrefix = :issuerPrefix " +
            "AND extensionDigit = :extensionDigit AND nextSerial <= toSerial",
    )
    suspend fun remaining(issuerPrefix: String, extensionDigit: Int): Long

    @Query("DELETE FROM sscc_pool")
    suspend fun clear()
}
