package app.markiro.handheld.core.replacement

import androidx.room.withTransaction
import app.markiro.handheld.BuildConfig
import app.markiro.handheld.core.grants.grantDigest
import app.markiro.handheld.core.network.ReplacementEvidenceRecovery
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.storage.DeviceOwner
import app.markiro.handheld.core.storage.GenerationToken
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaEntity
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import java.util.UUID

@Serializable
private data class EvidenceRecoveryRecord(
    val owner: DeviceOwner,
    val generation: Long,
    val recovery: ReplacementEvidenceRecovery,
    val sequence: Long = -1,
    val body: JsonObject? = null,
    val completed: Boolean = false,
)

/** Recovery purpose stays durable after completion so the released source cannot resume work. */
class ReplacementEvidenceRecoveryState(private val db: HandheldDatabase) {
    private val json = Json { encodeDefaults = true; ignoreUnknownKeys = false }

    private suspend fun saved() = db.metaDao().get(KEY)?.let {
        json.decodeFromString(EvidenceRecoveryRecord.serializer(), it)
    }

    private suspend fun save(record: EvidenceRecoveryRecord) {
        db.metaDao().put(MetaEntity(KEY, json.encodeToString(EvidenceRecoveryRecord.serializer(), record)))
        check(saved() == record) { "Recovery purpose not persisted" }
    }

    suspend fun blocked() = saved() != null

    suspend fun persistPublication(
        owner: DeviceOwner,
        generation: Long,
        binding: ReplacementEvidenceRecovery?,
    ) = db.withTransaction {
        val prior = saved()
        if (binding == null) {
            check(prior == null) { "Recovery purpose required" }
            return@withTransaction
        }
        binding.validate()
        if (prior != null) {
            require(prior.owner == owner && prior.generation <= generation)
            require(prior.recovery.executionId == binding.executionId)
            require(prior.recovery.credentialEpoch <= binding.credentialEpoch)
            if (prior.generation == generation) {
                require(prior.recovery == binding)
                return@withTransaction
            }
        }
        save(EvidenceRecoveryRecord(owner, generation, binding))
    }

    suspend fun report(token: GenerationToken, api: StationApi) {
        val local = ReplacementReadiness(db)
        val body = db.recovery.commit(token) {
            val row = checkNotNull(saved())
            require(row.owner == token.owner && row.generation == token.generation)
            if (row.completed) return@commit null
            row.body?.let { return@commit it }
            val snapshot = local.snapshot()
            val high = local.highestSequence()
            val revision = (db.metaDao().get(ReplacementReadiness.REVISION)?.toLongOrNull() ?: 1)
                .coerceAtLeast(1)
            val nextBody = buildJsonObject {
                put("requestId", UUID.randomUUID().toString())
                put("intentId", row.recovery.intentId)
                put("credentialEpoch", row.recovery.credentialEpoch)
                put("reportSequence", row.sequence + 1)
                put("storageRevision", revision)
                put("clientBuild", "handheld:${BuildConfig.VERSION_NAME}")
                snapshot.forEach { (key, value) -> put(key, value) }
                put("journal", buildJsonObject {
                    put("digest", grantDigest(snapshot.toString()))
                    put("highestSequence", high)
                })
            }
            // Pin the exact request before transport; a lost response must replay these bytes.
            save(row.copy(sequence = row.sequence + 1, body = nextBody))
            nextBody
        } ?: return
        val response = api.replacementRecoveryReadiness(body)
        require(response.keys == setOf("requestId", "intentId", "receivedAt", "unsupportedChannels", "eligibility"))
        require(response["requestId"] == body["requestId"] && response["intentId"] == body["intentId"])
        Instant.parse(response.text("receivedAt"))
        val eligibility = response.getValue("eligibility").jsonObject
        require(eligibility.getValue("reasons") is JsonArray && response.getValue("unsupportedChannels") is JsonArray)
        val status = eligibility.text("status")
        require(status in setOf("eligible", "blocked"))
        db.recovery.commit(token) {
            val row = checkNotNull(saved())
            require(row.owner == token.owner && row.generation == token.generation && row.body == body)
            save(row.copy(body = null, completed = status == "eligible"))
        }
    }

    companion object { const val KEY = "replacement_evidence_recovery_v1" }
}
