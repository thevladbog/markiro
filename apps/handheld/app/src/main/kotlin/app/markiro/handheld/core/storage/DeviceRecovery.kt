package app.markiro.handheld.core.storage

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.withTransaction
import app.markiro.handheld.core.network.PairResponse
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.asContextElement
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.util.UUID
import kotlin.coroutines.AbstractCoroutineContextElement
import kotlin.coroutines.CoroutineContext

@Serializable
data class DeviceOwner(val serverOrigin: String, val tenantId: String, val deviceId: String, val kind: String)
enum class RecoveryPhase { UNINITIALIZED, UNPAIRED, ACTIVE, SEALING, SEALED, RESTORING, OWNER_UNRESOLVED }
data class RecoveryState(val phase: RecoveryPhase = RecoveryPhase.UNINITIALIZED, val owner: DeviceOwner? = null, val generation: Long = 0)
data class GenerationToken(val owner: DeviceOwner, val generation: Long)
class RecoveryBlocked : CancellationException("Device data is sealed or this operation belongs to an earlier credential")
class RecoveryMismatch : IllegalArgumentException("Recovery owner mismatch")

@Entity(tableName = "device_recovery")
data class DeviceRecoveryEntity(
    @PrimaryKey val id: Int = 1,
    val serverOrigin: String?, val tenantId: String?, val deviceId: String?, val kind: String?,
    val generation: Long, val phase: String, val pendingId: String? = null,
) {
    fun owner(): DeviceOwner? = if (serverOrigin != null && tenantId != null && deviceId != null && kind != null) {
        DeviceOwner(serverOrigin, tenantId, deviceId, kind)
    } else null
    fun state() = RecoveryState(RecoveryPhase.valueOf(phase), owner(), generation)
}

@Dao
interface DeviceRecoveryDao {
    @Query("SELECT * FROM device_recovery WHERE id = 1") suspend fun get(): DeviceRecoveryEntity?
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun put(row: DeviceRecoveryEntity)
}

@Serializable
private data class Publication(val id: String, val owner: DeviceOwner, val generation: Long, val response: PairResponse)

/** One coordinator per database. Nothing can admit work until initialize has resolved its owner. */
class DeviceRecovery(private val db: HandheldDatabase, private val credential: CredentialStore) {
    private val transitions = Mutex()
    private val commits = Mutex()
    private val mutable = MutableStateFlow(RecoveryState())
    val state: StateFlow<RecoveryState> = mutable
    private val json = Json { encodeDefaults = true }
    init { db.attachRecovery(this) }

    suspend fun initialize() = transitions.withLock {
        val observed = mutable.value
        if (observed.phase !in setOf(RecoveryPhase.UNINITIALIZED, RecoveryPhase.SEALING, RecoveryPhase.RESTORING)) return@withLock
        var row = db.deviceRecoveryDao().get()
        val config = db.deviceConfigDao().get()
        if (row == null) {
            val owner = config?.let { ownerOf(it.serverUrl, it.tenantId, it.deviceId, it.kind) }
            val phase = when {
                owner != null && !legacyOwnerConsistent(owner) -> RecoveryPhase.OWNER_UNRESOLVED
                owner != null -> if (credential.read() != null) RecoveryPhase.ACTIVE else RecoveryPhase.SEALED
                config != null || hasRetainedData() -> RecoveryPhase.OWNER_UNRESOLVED
                else -> RecoveryPhase.UNPAIRED
            }
            row = DeviceRecoveryEntity(serverOrigin = owner?.serverOrigin, tenantId = owner?.tenantId,
                deviceId = owner?.deviceId, kind = owner?.kind, generation = if (owner == null) 0 else 1, phase = phase.name)
            db.deviceRecoveryDao().put(row)
        }
        if (!ownerConsistent(row)) {
            seal(row.copy(phase = RecoveryPhase.OWNER_UNRESOLVED.name))
            return@withLock
        }
        // A failed first intent write leaves Room ACTIVE but memory SEALING. Never reopen
        // that generation during an in-process retry, even while the old key still exists.
        if (observed.phase == RecoveryPhase.SEALING && observed.owner == row.owner() && observed.generation == row.generation) {
            commits.withLock { seal(row) }
        } else if (row.phase == RecoveryPhase.RESTORING.name) {
            mutable.value = row.state()
            completePublication(row)
        } else if (row.phase in setOf(RecoveryPhase.SEALING.name, RecoveryPhase.SEALED.name, RecoveryPhase.OWNER_UNRESOLVED.name) ||
            row.phase == RecoveryPhase.ACTIVE.name && credential.read() == null) {
            commits.withLock { seal(row) }
        } else {
            mutable.value = row.state()
        }
        if (mutable.value.phase == RecoveryPhase.ACTIVE && credential.staged() != null) credential.clearStaged()
    }

    /** Validate the durable owner before every recovery/publication path, not just ACTIVE startup. */
    private suspend fun ownerConsistent(row: DeviceRecoveryEntity): Boolean {
        if (row.phase !in RecoveryPhase.entries.map { it.name } || row.generation < 0) return false
        val config = db.deviceConfigDao().get()
        if (row.phase == RecoveryPhase.UNPAIRED.name) {
            return row.serverOrigin == null && row.tenantId == null && row.deviceId == null && row.kind == null &&
                row.generation == 0L && config == null && !hasRetainedData() && db.operatorDao().all().isEmpty() && credential.read() == null
        }
        val owner = row.owner() ?: return false
        if (row.generation < 1 || ownerOf(owner.serverOrigin, owner.tenantId, owner.deviceId, owner.kind) != owner) return false
        if (config == null) {
            // A fresh publication can lose its staged candidate before creating config.
            // Sealing and repeated authorized retries may advance its generation. Only
            // completely empty, blocked states may retry under the same validated owner;
            // ACTIVE or any retained operational/roster data still requires saved config.
            return row.phase in setOf(RecoveryPhase.RESTORING.name, RecoveryPhase.SEALING.name, RecoveryPhase.SEALED.name) &&
                !hasRetainedData() && db.operatorDao().all().isEmpty()
        }
        return ownerOf(config.serverUrl, config.tenantId, config.deviceId, config.kind) == owner && legacyOwnerConsistent(owner)
    }

    fun current() = mutable.value
    fun token(): GenerationToken {
        val current = mutable.value
        if (current.phase != RecoveryPhase.ACTIVE) throw RecoveryBlocked()
        return GenerationToken(checkNotNull(current.owner), current.generation)
    }
    fun valid(token: GenerationToken): Boolean {
        val current = mutable.value
        return current.phase == RecoveryPhase.ACTIVE && current.owner == token.owner && current.generation == token.generation
    }
    fun key(token: GenerationToken): String {
        if (!valid(token)) throw RecoveryBlocked()
        return credential.read() ?: throw RecoveryBlocked()
    }

    /** A scope survives suspension; nested owners inherit it instead of adopting a rotated key. */
    suspend fun <T> work(block: suspend () -> T): T {
        if (currentCoroutineContext()[CommitLease]?.recovery === this) return block()
        val existing = generationContext.get()
        val token = existing ?: token()
        if (!valid(token)) throw RecoveryBlocked()
        return if (existing != null) block() else withContext(generationContext.asContextElement(token)) { block() }
    }

    suspend fun <T> guard(token: GenerationToken, block: () -> T): T = commits.withLock {
        if (!valid(token)) throw RecoveryBlocked()
        block()
    }

    suspend fun <T> commit(token: GenerationToken, block: suspend () -> T): T =
        withContext(generationContext.asContextElement(token)) { commit(block) }

    suspend fun <T> work(token: GenerationToken, block: suspend () -> T): T =
        withContext(generationContext.asContextElement(token)) { work(block) }

    /** Short, reentrant lease: no HTTP waits inside a Room transaction. */
    suspend fun <T> commit(block: suspend () -> T): T = work {
        val token = checkNotNull(generationContext.get())
        val lease = currentCoroutineContext()[CommitLease]
        if (lease?.recovery === this) {
            if (lease.transaction) block() else withContext(CommitLease(this, true)) { db.withTransaction { block() } }
        } else commits.withLock {
            if (!valid(token)) throw RecoveryBlocked()
            withContext(CommitLease(this, true)) { db.withTransaction { block() } }
        }
    }

    /** Serialize local preparation with commits/printing without holding a Room transaction. */
    suspend fun <T> exclusive(block: suspend () -> T): T = work {
        if (currentCoroutineContext()[CommitLease]?.recovery === this) block()
        else commits.withLock {
            if (!valid(checkNotNull(generationContext.get()))) throw RecoveryBlocked()
            withContext(CommitLease(this, false)) { block() }
        }
    }

    /** Transport is admitted while holding the lease, then drained before secret publication.
     * No Room transaction spans printer I/O. Cancellation still leaves the saved PRINTING fact.
     */
    suspend fun <T> printing(block: suspend () -> T): T = work {
        val token = checkNotNull(generationContext.get())
        commits.withLock {
            if (!valid(token)) throw RecoveryBlocked()
            withContext(NonCancellable + CommitLease(this, false)) { block() }
        }
    }

    /** The compare-and-set includes phase, owner and generation in one atomic decision. */
    internal fun beginSealing(observed: RecoveryState): Boolean = observed.phase == RecoveryPhase.ACTIVE &&
        mutable.compareAndSet(observed, observed.copy(phase = RecoveryPhase.SEALING))

    suspend fun reject(token: GenerationToken): Boolean {
        val observed = mutable.value
        if (observed.owner != token.owner || observed.generation != token.generation) return false
        if (!beginSealing(observed) && observed.phase != RecoveryPhase.SEALING) return false
        return withContext(NonCancellable) {
            transitions.withLock {
                val row = db.deviceRecoveryDao().get() ?: return@withLock false
                if (row.owner() != token.owner || row.generation != token.generation ||
                    row.phase !in setOf(RecoveryPhase.ACTIVE.name, RecoveryPhase.SEALING.name)) return@withLock false
                val sealing = row.copy(phase = RecoveryPhase.SEALING.name)
                // Do not clear either secret store until the blocked intent is durable.
                db.deviceRecoveryDao().put(sealing)
                commits.withLock { seal(sealing) }
                true
            }
        }
    }

    private suspend fun seal(row: DeviceRecoveryEntity) {
        // Intent is durable before either secret store is touched. A failing commit remains sealed.
        val unresolved = row.phase == RecoveryPhase.OWNER_UNRESOLVED.name
        val intent = row.copy(phase = if (unresolved) RecoveryPhase.OWNER_UNRESOLVED.name else RecoveryPhase.SEALING.name, pendingId = null)
        mutable.value = intent.state()
        db.deviceRecoveryDao().put(intent)
        db.operatorDao().clear()
        credential.clear()
        val sealed = intent.copy(phase = if (unresolved) RecoveryPhase.OWNER_UNRESOLVED.name else RecoveryPhase.SEALED.name)
        db.deviceRecoveryDao().put(sealed)
        mutable.value = sealed.state()
    }

    suspend fun restore(response: PairResponse, serverUrl: String) = transitions.withLock {
        val row = checkNotNull(db.deviceRecoveryDao().get())
        if (!ownerConsistent(row)) {
            seal(row.copy(phase = RecoveryPhase.OWNER_UNRESOLVED.name))
            throw RecoveryMismatch()
        }
        val owner = ownerOf(serverUrl, response.device.tenantId, response.device.id, response.device.kind) ?: throw RecoveryMismatch()
        if (row.phase == RecoveryPhase.OWNER_UNRESOLVED.name || row.owner()?.let { it != owner } == true) throw RecoveryMismatch()
        if (row.phase == RecoveryPhase.ACTIVE.name && row.owner() == owner && credential.read() == response.credential.apiKey) {
            credential.clearStaged()
            return@withLock
        }
        if (row.phase == RecoveryPhase.RESTORING.name) {
            if (credential.staged() == null) credential.stage(json.encodeToString(Publication.serializer(), Publication(checkNotNull(row.pendingId), owner, row.generation, response)))
            completePublication(row)
            return@withLock
        }
        check(row.phase == RecoveryPhase.SEALED.name || row.phase == RecoveryPhase.UNPAIRED.name)
        require(response.credential.apiKey.isNotBlank())
        val id = UUID.randomUUID().toString()
        val intent = row.copy(serverOrigin = owner.serverOrigin, tenantId = owner.tenantId, deviceId = owner.deviceId,
            kind = owner.kind, phase = RecoveryPhase.RESTORING.name, generation = row.generation + 1, pendingId = id)
        db.deviceRecoveryDao().put(intent)
        mutable.value = intent.state()
        credential.stage(json.encodeToString(Publication.serializer(), Publication(id, owner, intent.generation, response)))
        completePublication(intent)
    }

    /** Retry publication locally; never redeem a second code after receiving a usable candidate. */
    suspend fun resumePublication(): Boolean = transitions.withLock {
        val row = db.deviceRecoveryDao().get() ?: return@withLock false
        if (row.phase != RecoveryPhase.RESTORING.name) return@withLock false
        completePublication(row)
        mutable.value.phase == RecoveryPhase.ACTIVE
    }

    private suspend fun completePublication(row: DeviceRecoveryEntity) {
        if (!ownerConsistent(row)) {
            seal(row.copy(phase = RecoveryPhase.OWNER_UNRESOLVED.name))
            throw RecoveryMismatch()
        }
        val publication = credential.staged()?.let { runCatching { json.decodeFromString(Publication.serializer(), it) }.getOrNull() }
        if (publication == null) { seal(row); return }
        check(publication.id == row.pendingId && publication.owner == row.owner() && publication.generation == row.generation)
        credential.write(publication.response.credential.apiKey)
        val device = publication.response.device
        db.withTransaction {
            val old = db.deviceConfigDao().get()
            // Retain task references and original snapshots; pairing only refreshes display metadata.
            val config = old?.copy(deviceName = device.name, organizationName = device.organizationName,
                lineId = device.line?.id, lineName = device.line?.name, rosterFetchedAt = System.currentTimeMillis()) ?: DeviceConfigEntity(
                deviceId = device.id, deviceName = device.name, tenantId = device.tenantId,
                organizationName = device.organizationName, lineId = device.line?.id, lineName = device.line?.name,
                kind = device.kind, serverUrl = publication.owner.serverOrigin, pairedAt = System.currentTimeMillis(),
            )
            db.operatorDao().replaceAll(publication.response.operators.map {
                OperatorEntity(it.operatorId, it.name, it.login, it.role, it.pinHash, it.badgeHash, it.active)
            })
            db.deviceConfigDao().upsert(config)
            // BOTH kinds of label, exactly as startup demotes both
            // (`HandheldApp.demoteInterruptedPrints`): re-pairing is the other
            // way a process that died mid-print resumes. «Напечатать все»
            // skips only `unknown`, so a pallet left in `printing` would be
            // resent in bulk -- a second physical label on a stack the server
            // may already have accepted, which is the single thing the
            // `unknown` state exists to prevent.
            db.boxDao().demoteInterruptedPrints()
            db.palletDao().demoteInterruptedPrints()
            db.deviceRecoveryDao().put(row.copy(phase = RecoveryPhase.ACTIVE.name, pendingId = null))
        }
        // A failed cleanup never revokes the published candidate. Startup can retry this cleanup.
        mutable.value = row.copy(phase = RecoveryPhase.ACTIVE.name, pendingId = null).state()
        credential.clearStaged()
    }

    /**
     * What the operator staring at a blocked terminal is owed, channel by
     * channel.
     *
     * `pallets` is its own line rather than folded into `boxes`: a closed
     * pallet the server has not acknowledged is a physically labelled stack
     * whose closure only this device knows about, counted here on the same
     * `closedAt IS NOT NULL AND ackedAt IS NULL` terms the sync engine's own
     * queue indicator already counts it on (`SyncEngine.observeUnackedCount`).
     * Its interrupted and unknown prints join `unknownPrints` for the same
     * reason a box's do -- `PalletPrinter` mirrors `BoxPrinter` state for
     * state, so a pallet label with an unresolved outcome needs the same pair
     * of eyes.
     */
    suspend fun summary(): Map<String, Long> = db.withTransaction {
        mapOf("scans" to count("outbox"), "inventory" to count("inventory_outbox"),
            "labels" to count("product_label_events", "ackedAt IS NULL"), "boxes" to count("boxes", "closedAt IS NOT NULL AND ackedAt IS NULL"),
            "pallets" to count("pallets", "closedAt IS NOT NULL AND ackedAt IS NULL"),
            "exceptions" to count("box_exceptions", "ackedAt IS NULL"), "closes" to count("shift_close_outbox", "state = 'pending'"),
            "conflicts" to count("conflicts_mirror"), "unknownPrints" to count("boxes", "printState IN ('printing','unknown')") +
                count("pallets", "printState IN ('printing','unknown')") +
                count("product_label_jobs", "attemptState IN ('sending','delivery_unknown')"))
    }
    private fun count(table: String, where: String = "1") = db.openHelper.readableDatabase.query("SELECT COUNT(*) FROM `$table` WHERE $where").use { it.moveToFirst(); it.getLong(0) }
    /** Only locally authored identity anchors constrain ownership. Server conflict winners may
     * legitimately name another terminal and must remain unchanged. Older journals without an
     * embedded owner inherit the single consistent config observation, never a new pairing.
     */
    private suspend fun legacyOwnerConsistent(owner: DeviceOwner): Boolean = db.withTransaction {
        val sqlite = db.openHelper.readableDatabase
        val pin = db.metaDao().get(MetaStore.SYNC_PENDING_BATCH_ID)
        if (pin != null && !pin.startsWith(owner.deviceId + ":")) return@withTransaction false
        sqlite.query("SELECT winningDeviceId FROM inventory_results WHERE source = 'local'").use { rows ->
            while (rows.moveToNext()) if (rows.getString(0) != owner.deviceId) return@withTransaction false
        }
        for (table in listOf("box_exceptions", "product_label_events", "inventory_outbox")) {
            sqlite.query("SELECT payloadJson FROM `$table`").use { rows ->
                while (rows.moveToNext()) {
                    val payload = runCatching { json.parseToJsonElement(rows.getString(0)) as? JsonObject }.getOrNull()
                        ?: return@withTransaction false
                    for ((field, expected) in listOf("terminalId" to owner.deviceId, "deviceId" to owner.deviceId, "tenantId" to owner.tenantId)) {
                        val value = payload[field] ?: continue
                        if (value == JsonNull) continue
                        if (value !is JsonPrimitive || !value.isString || value.content != expected) return@withTransaction false
                    }
                }
            }
        }
        true
    }

    private fun hasRetainedData(): Boolean = db.openHelper.readableDatabase.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('device_config','device_recovery','operators','room_master_table','android_metadata')",
    ).use { tables -> var found = false; while (tables.moveToNext()) if (count(tables.getString(0)) > 0) found = true; found }

    private class CommitLease(val recovery: DeviceRecovery, val transaction: Boolean) : AbstractCoroutineContextElement(Key) {
        companion object Key : CoroutineContext.Key<CommitLease>
    }
    companion object {
        val generationContext = ThreadLocal<GenerationToken?>()
        fun ownerOf(server: String, tenant: String, device: String, kind: String): DeviceOwner? {
            val url = server.trim().toHttpUrlOrNull() ?: return null
            if (tenant.isBlank() || device.isBlank() || kind != "handheld" || url.username.isNotEmpty() || url.password.isNotEmpty()) return null
            return DeviceOwner(url.newBuilder().encodedPath("/").query(null).fragment(null).build().toString().trimEnd('/'), tenant, device, kind)
        }
    }
}
