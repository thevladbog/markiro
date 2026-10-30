package app.markiro.handheld.core.host

import app.markiro.handheld.core.network.host.*
import app.markiro.handheld.core.storage.*
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.util.UUID

/** Authorization provenance is local state, never a host wire field. */
data class InspectedPack(
    val data: PackInspectionDto, val owner: DeviceOwner, val generation: Long,
    val datasetEpoch: String?, val operatorId: String,
) { val reasons get() = data.reasons }

@Serializable
data class PendingPackDisassembly(
    val owner: DeviceOwner, val generation: Long, val datasetEpoch: String?,
    val body: String, val inspection: PackInspectionDto,
) {
    fun request(): PackDisassembleDto = Json.decodeFromString(PackDisassembleDto.serializer(), body)
}
class PackDisassemblyFailure(val code: String, val uncertain: Boolean = false) : Exception(code)

interface PackDisassemblyGateway {
    suspend fun pending(): PendingPackDisassembly?
    suspend fun canResume(pending: PendingPackDisassembly, operatorId: String): Boolean
    suspend fun lookup(sscc: String, operatorId: String): InspectedPack
    suspend fun prepare(inspection: InspectedPack, reason: PackReasonDto, operatorId: String): PendingPackDisassembly
    suspend fun submit(pending: PendingPackDisassembly): PackDisassembledDto
    /** Explicit reconciliation acknowledgement: preserve evidence, never resend under a new owner. */
    suspend fun archive(pending: PendingPackDisassembly)
}

/** A confirmed intent is durable BEFORE the first network attempt, and removed only by its own definite outcome. */
class HostPackDisassembly(
    private val db: HandheldDatabase,
    private val apiFor: (GenerationToken) -> HostApi,
    private val calls: HostCalls,
    private val refresh: suspend () -> Unit,
    private val nudge: () -> Unit,
) : PackDisassemblyGateway {
    private val json = Json { ignoreUnknownKeys = true }
    override suspend fun pending(): PendingPackDisassembly? = db.metaDao().get(PENDING_KEY)?.let {
        try {
            json.decodeFromString(PendingPackDisassembly.serializer(), it).also { pending ->
                val request=pending.request()
                UUID.fromString(request.requestId)
                check(request.sscc==pending.inspection.sscc && request.expectedToken==pending.inspection.token)
            }
        }
        catch (_: Exception) { throw PackDisassemblyFailure("saved_unreadable", true) }
    }
    override suspend fun canResume(pending: PendingPackDisassembly, operatorId: String): Boolean {
        val config = db.deviceConfigDao().get() ?: return false
        val state = db.recovery.current()
        return config.backend == "host" && state.owner == pending.owner && state.generation == pending.generation &&
            config.hostDatasetEpoch == pending.datasetEpoch && db.recovery.valid(GenerationToken(pending.owner,pending.generation)) &&
            pending.request().operatorId == operatorId
    }
    private suspend fun <T> call(block: suspend () -> Result<T>): T {
        var error: HostApiError? = null
        return try { calls.run { block().also { error = it.exceptionOrNull() as? HostApiError } } } catch (blocked: RecoveryBlocked) { throw blocked }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) {
            val code = when(val failure=error?.failure) {
                is HostFailure.Constraint -> failure.name
                is HostFailure.RestorePending -> "restore_hold"
                HostFailure.CertificateMismatch -> "certificate"
                HostFailure.Forbidden -> "forbidden"
                HostFailure.ProtocolUnsupported -> "protocol_unsupported"
                else -> if(error?.status==404) "host_update" else "unavailable"
            }
            throw PackDisassemblyFailure(code, code !in DEFINITE_REFUSALS)
        }
    }
    override suspend fun lookup(sscc: String, operatorId: String): InspectedPack {
        val token=db.recovery.token()
        return db.recovery.work(token) {
            val config=checkNotNull(db.deviceConfigDao().get())
            if(config.backend!="host") throw PackDisassemblyFailure("host_only")
            val card=call { apiFor(token).packInspection(sscc,operatorId) }
            if(card.sscc!=sscc || card.kind !in setOf("box","pallet") || card.boxes<0 || card.units<0 || !TOKEN.matches(card.token)) throw PackDisassemblyFailure("unavailable")
            if(!db.recovery.valid(token) || db.deviceConfigDao().get()?.hostDatasetEpoch!=config.hostDatasetEpoch) throw RecoveryBlocked()
            InspectedPack(card,token.owner,token.generation,config.hostDatasetEpoch,operatorId)
        }
    }
    override suspend fun prepare(inspection: InspectedPack, reason: PackReasonDto, operatorId: String): PendingPackDisassembly = db.recovery.commit {
        check(db.metaDao().get(PENDING_KEY)==null) { "An unresolved operation already exists" }
        val config=checkNotNull(db.deviceConfigDao().get());check(config.backend=="host")
        val token=db.recovery.token()
        if(token.owner!=inspection.owner || token.generation!=inspection.generation || config.hostDatasetEpoch!=inspection.datasetEpoch || operatorId!=inspection.operatorId) throw RecoveryBlocked()
        val card=inspection.data
        check(card.status=="ok" && card.reasons.any { it==reason } && TOKEN.matches(card.token))
        val request=PackDisassembleDto(UUID.randomUUID().toString(),card.sscc,operatorId,reason.id,card.token)
        PendingPackDisassembly(inspection.owner,inspection.generation,inspection.datasetEpoch,json.encodeToString(PackDisassembleDto.serializer(),request),card).also {
            db.metaDao().put(MetaEntity(PENDING_KEY,json.encodeToString(PendingPackDisassembly.serializer(),it)))
        }
    }
    override suspend fun submit(pending: PendingPackDisassembly): PackDisassembledDto {
        val request=pending.request()
        if(!canResume(pending,request.operatorId)) throw RecoveryBlocked()
        return db.recovery.work(GenerationToken(pending.owner,pending.generation)) {
            check(this@HostPackDisassembly.pending()==pending)
            val answer=try { call { apiFor(GenerationToken(pending.owner,pending.generation)).disassemblePack(pending.body) } }
            catch(error:PackDisassemblyFailure) {
                if(!error.uncertain) db.recovery.commit { clearOwn(pending) }
                throw error
            }
            if(answer.sscc!=request.sscc || answer.kind!=pending.inspection.kind || answer.docNo.isBlank() ||
                runCatching { UUID.fromString(answer.documentId); java.time.Instant.parse(answer.appliedAt) }.isFailure) throw PackDisassemblyFailure("unavailable",true)
            db.recovery.commit {
                check(this@HostPackDisassembly.pending()==pending)
                if(answer.kind=="box") {
                    db.boxRegistryDao().remove(answer.sscc)
                    db.boxDao().bySscc(answer.sscc)?.let { box ->
                        db.boxDao().markDisassembled(box.boxId,answer.appliedAt)
                        db.codeDao().deleteInBox(box.boxId)
                    }
                } else {
                    db.boxRegistryDao().clearRetiredPallet(answer.sscc)
                    db.palletDao().bySscc(answer.sscc)?.let { pallet ->
                        db.palletDao().markDisassembled(pallet.palletId,answer.appliedAt)
                        db.boxRegistryDao().releaseAll(pallet.palletId)
                    }
                }
                clearOwn(pending)
            }
            // Cache refresh never changes a known successful host result into a failure.
            try { refresh() } catch(cancelled:CancellationException) { throw cancelled } catch(_:Exception) { }
            nudge()
            answer
        }
    }
    private suspend fun clearOwn(pending:PendingPackDisassembly) {
        check(this.pending()==pending)
        db.metaDao().remove(PENDING_KEY)
    }
    override suspend fun archive(pending: PendingPackDisassembly) = db.recovery.commit {
        check(this@HostPackDisassembly.pending()==pending)
        db.metaDao().put(MetaEntity(EVIDENCE_PREFIX+pending.request().requestId,json.encodeToString(PendingPackDisassembly.serializer(),pending)))
        clearOwn(pending)
    }
    companion object {
        const val PENDING_KEY="pack_disassembly_pending_v1"
        const val EVIDENCE_PREFIX="pack_disassembly_evidence_v1:"
        private val TOKEN=Regex("[a-f0-9]{64}")
        private val DEFINITE_REFUSALS=setOf("pack_changed","shift_open","already_disassembled","not_closed","reason_required","pack_not_found","demo_box","cloud_history","forbidden","protocol_unsupported")
    }
}
