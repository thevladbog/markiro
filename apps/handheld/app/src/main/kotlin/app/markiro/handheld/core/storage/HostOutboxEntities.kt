package app.markiro.handheld.core.storage

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query

/**
 * A record for the host, frozen: `body` is the JSON of one record exactly as it will be sent (and sent again), `recordId` its UUID
 * (the host's idempotency key), `seq` its place in the queue. `sourceKind` + `sourceKey` name the Room row it was made of, so the
 * freezer never makes two records of one row. `state`: `queued`, or `quarantined` with the host's `reason` (a refused record stays
 * for support, it never blocks the others). An acknowledged record is deleted together with the acknowledgement of its source row.
 */
@Entity(
    tableName = "host_outbox",
    indices = [
        Index(value = ["recordId"], unique = true),
        Index(value = ["sourceKind", "sourceKey"], unique = true),
        Index(value = ["state", "seq"]),
    ],
)
data class HostOutboxEntity(
    @PrimaryKey(autoGenerate = true) val seq: Long = 0,
    val recordId: String,
    /** `facts` (`POST /v1/device/facts`) or `events` (`POST /v1/device/pallet-events`). */
    val target: String,
    val kind: String,
    val sourceKind: String,
    val sourceKey: String,
    val body: String,
    val state: String,
    val reason: String?,
    val createdAt: String,
)

@Dao
interface HostOutboxDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insert(row: HostOutboxEntity): Long

    @Query("SELECT * FROM host_outbox WHERE state = 'queued' ORDER BY seq LIMIT :limit")
    suspend fun queued(limit: Int): List<HostOutboxEntity>

    /** The head of one channel's queue, in the order the records were frozen (`seq`): a quarantined record is never sent again. */
    @Query("SELECT * FROM host_outbox WHERE target = :target AND state = 'queued' ORDER BY seq LIMIT :limit")
    suspend fun queuedFor(target: String, limit: Int): List<HostOutboxEntity>

    @Query("SELECT COUNT(*) FROM host_outbox WHERE state = 'queued'")
    suspend fun queuedCount(): Int

    @Query("SELECT COUNT(*) FROM host_outbox WHERE state = 'quarantined'")
    suspend fun quarantinedCount(): Int

    @Query("SELECT * FROM host_outbox WHERE state = 'quarantined' ORDER BY seq")
    suspend fun quarantined(): List<HostOutboxEntity>

    // Sources not yet frozen: a row of its own table with no `host_outbox` row naming it. A source stays frozen (and is never frozen
    // twice) for as long as its record is queued or quarantined; an acknowledged record removes its row together with the source.

    @Query("SELECT * FROM outbox WHERE CAST(id AS TEXT) NOT IN (SELECT sourceKey FROM host_outbox WHERE sourceKind = 'scan') ORDER BY id")
    suspend fun unfrozenScans(): List<OutboxEntity>

    @Query(
        "SELECT * FROM boxes WHERE closedAt IS NOT NULL AND ackedAt IS NULL AND sscc IS NOT NULL " +
            "AND boxId NOT IN (SELECT sourceKey FROM host_outbox WHERE sourceKind = 'box') ORDER BY closedAt, boxId",
    )
    suspend fun unfrozenBoxes(): List<BoxEntity>

    /** Pallets of a shift only: a warehouse pallet belongs to no shift and travels on the pallet-events channel. */
    @Query(
        "SELECT * FROM pallets WHERE kind = 'production' AND shiftId IS NOT NULL AND closedAt IS NOT NULL AND ackedAt IS NULL " +
            "AND sscc IS NOT NULL AND palletId NOT IN (SELECT sourceKey FROM host_outbox WHERE sourceKind = 'pallet') ORDER BY closedAt, palletId",
    )
    suspend fun unfrozenPallets(): List<PalletEntity>

    @Query(
        "SELECT * FROM shift_close_outbox WHERE state = 'pending' " +
            "AND eventId NOT IN (SELECT sourceKey FROM host_outbox WHERE sourceKind = 'shift_close') ORDER BY closedAt",
    )
    suspend fun unfrozenCloses(): List<ShiftCloseEntity>

    // The warehouse pallets' sources (the pallet-events channel). A pallet of the device is not a record until it is frozen; `ackedAt` is the
    // acknowledgement of its close, a membership leaves `pending` when it is frozen (`sent`) and settles on its receipt.

    @Query("SELECT * FROM pallets WHERE kind = 'warehouse' AND ackedAt IS NULL ORDER BY openedAt, palletId")
    suspend fun unackedWarehousePallets(): List<PalletEntity>

    /** Boxes of the pallet whose events are not settled yet (frozen and unanswered, or not frozen). */
    @Query("SELECT COUNT(*) FROM pallet_memberships WHERE palletId = :palletId AND status IN ('pending', 'sent')")
    suspend fun unsettledMemberships(palletId: String): Int

    @Query("SELECT COUNT(*) FROM pallet_membership_removals WHERE palletId = :palletId")
    suspend fun unsettledRemovals(palletId: String): Int

    @Query("SELECT COUNT(*) FROM pallet_memberships WHERE palletId = :palletId")
    suspend fun membershipRows(palletId: String): Int

    @Query("SELECT codeHash FROM codes_mirror WHERE boxId = :boxId")
    suspend fun codeHashesIn(boxId: String): List<String>

    /** Everything the host is still owed on the facts and events channels: frozen and unsent, plus not yet frozen. */
    @Query(
        "SELECT (SELECT COUNT(*) FROM host_outbox WHERE state = 'queued') " +
            "+ (SELECT COUNT(*) FROM outbox WHERE CAST(id AS TEXT) NOT IN (SELECT sourceKey FROM host_outbox WHERE sourceKind = 'scan')) " +
            "+ (SELECT COUNT(*) FROM boxes WHERE closedAt IS NOT NULL AND ackedAt IS NULL AND sscc IS NOT NULL " +
            "AND boxId NOT IN (SELECT sourceKey FROM host_outbox WHERE sourceKind = 'box')) " +
            "+ (SELECT COUNT(*) FROM pallets WHERE kind = 'production' AND shiftId IS NOT NULL AND closedAt IS NOT NULL AND ackedAt IS NULL " +
            "AND sscc IS NOT NULL AND palletId NOT IN (SELECT sourceKey FROM host_outbox WHERE sourceKind = 'pallet')) " +
            "+ (SELECT COUNT(*) FROM shift_close_outbox WHERE state = 'pending' " +
            "AND eventId NOT IN (SELECT sourceKey FROM host_outbox WHERE sourceKind = 'shift_close')) " +
            "+ (SELECT COUNT(*) FROM pallet_memberships WHERE status = 'pending') " +
            "+ (SELECT COUNT(*) FROM pallet_membership_removals WHERE status = 'pending') " +
            "+ (SELECT COUNT(*) FROM pallets WHERE kind = 'warehouse' AND closedAt IS NOT NULL AND ackedAt IS NULL AND sscc IS NOT NULL " +
            "AND palletId NOT IN (SELECT sourceKey FROM host_outbox WHERE sourceKind = 'warehouse_pallet_closed'))",
    )
    fun observeOwed(): kotlinx.coroutines.flow.Flow<Int>

    @Query("SELECT COUNT(*) FROM host_outbox WHERE state = 'quarantined'")
    fun observeQuarantinedCount(): kotlinx.coroutines.flow.Flow<Int>

    @Query("SELECT * FROM host_outbox WHERE state = 'quarantined' ORDER BY seq")
    fun observeQuarantined(): kotlinx.coroutines.flow.Flow<List<HostOutboxEntity>>

    @Query("SELECT COUNT(*) FROM host_outbox WHERE sourceKind = :kind AND sourceKey = :key")
    suspend fun frozen(kind: String, key: String): Int

    @Query("SELECT sourceKey FROM host_outbox WHERE sourceKind = :kind")
    suspend fun frozenKeys(kind: String): List<String>

    @Query("UPDATE host_outbox SET state = 'quarantined', reason = :reason WHERE recordId = :recordId")
    suspend fun quarantine(recordId: String, reason: String)

    @Query("DELETE FROM host_outbox WHERE recordId = :recordId")
    suspend fun delete(recordId: String)

    @Query("DELETE FROM host_outbox WHERE state = 'quarantined' AND recordId = :recordId")
    suspend fun dismiss(recordId: String)

    @Query("DELETE FROM host_outbox")
    suspend fun clear()
}
