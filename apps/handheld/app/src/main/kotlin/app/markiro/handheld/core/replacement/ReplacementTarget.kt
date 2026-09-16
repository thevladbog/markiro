package app.markiro.handheld.core.replacement

import androidx.room.withTransaction
import app.markiro.handheld.core.network.ReplacementTargetFence
import app.markiro.handheld.core.storage.DeviceOwner
import app.markiro.handheld.core.storage.GenerationToken
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaEntity
import kotlinx.coroutines.flow.map
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

@Serializable
private data class TargetFenceRecord(
    val owner: DeviceOwner,
    val generation: Long,
    val fence: ReplacementTargetFence,
)

/** A paired target stays blocked until an exact authenticated server projection reaches its boundary. */
class ReplacementTarget(private val db: HandheldDatabase) {
    private val json = Json { encodeDefaults = true; ignoreUnknownKeys = false }
    private suspend fun saved() = db.metaDao().get(KEY)?.let {
        json.decodeFromString(TargetFenceRecord.serializer(), it)
    }
    private fun waiting(fence: ReplacementTargetFence): Boolean {
        fence.validate()
        return fence.serverTime < fence.newWorkAllowedAt
    }
    suspend fun blocked(): Boolean = saved()?.let { waiting(it.fence) } ?: false
    val waiting = db.metaDao().observe(KEY).map { raw ->
        raw?.let { waiting(json.decodeFromString(TargetFenceRecord.serializer(), it).fence) } ?: false
    }

    /** Called during RESTORING, before candidate key/config publication. No active generation required. */
    suspend fun persistPublication(owner: DeviceOwner, generation: Long, fence: ReplacementTargetFence?) = db.withTransaction {
        val old = saved()
        if (fence == null) {
            check(old == null || !waiting(old.fence)) { "Replacement boundary required" }
            return@withTransaction
        }
        fence.validate()
        if (old != null) {
            require(
                old.owner == owner && old.generation <= generation &&
                    old.fence.executionId == fence.executionId &&
                    old.fence.newWorkAllowedAt == fence.newWorkAllowedAt &&
                    old.fence.credentialEpoch <= fence.credentialEpoch &&
                    old.fence.serverTime <= fence.serverTime
            )
        }
        val next = TargetFenceRecord(owner, generation, fence)
        db.metaDao().put(MetaEntity(KEY, json.encodeToString(TargetFenceRecord.serializer(), next)))
        check(saved() == next) { "Replacement fence was not persisted" }
    }

    suspend fun applyConfiguration(token: GenerationToken, fence: ReplacementTargetFence?) = db.recovery.commit(token) {
        if (fence == null) return@commit
        fence.validate()
        val old = checkNotNull(saved()) { "Replacement pairing boundary missing" }
        require(
            old.owner == token.owner && old.generation == token.generation &&
                old.fence.executionId == fence.executionId &&
                old.fence.credentialEpoch == fence.credentialEpoch &&
                old.fence.newWorkAllowedAt == fence.newWorkAllowedAt
        )
        if (fence.serverTime < old.fence.serverTime) return@commit
        val next = old.copy(fence = fence)
        db.metaDao().put(MetaEntity(KEY, json.encodeToString(TargetFenceRecord.serializer(), next)))
        check(saved() == next)
    }

    companion object { const val KEY = "device_replacement_target_v1" }
}
