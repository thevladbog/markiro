package app.markiro.handheld.core.grants

import app.markiro.handheld.core.storage.DeviceOwner
import app.markiro.handheld.core.storage.GenerationToken
import app.markiro.handheld.core.storage.HandheldDatabase
import kotlinx.serialization.json.*
import java.security.MessageDigest

internal fun DeviceOwner.grantOwnerKey(): String = JsonArray(listOf(serverOrigin, tenantId, deviceId, kind).map(::JsonPrimitive)).toString()
internal fun grantDigest(value: String): String = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
internal fun grantSlot(owner: String, kind: String, task: String) = JsonArray(listOf(owner, kind, task).map(::JsonPrimitive)).toString()

class GrantDenied internal constructor(val decision: GrantEvidenceEntity, internal val clockState: GrantStateEntity?) : IllegalStateException("Offline grant: ${decision.reason}")
internal data class GrantRefreshTicket(val token: GenerationToken, val sequence: Long)

/** Every admission is nested in the business owner's recovery commit; no network or signature work here. */
class GrantRepository(private val db: HandheldDatabase) {
    internal var sample: () -> ClockSample = AndroidGrantClock::sample
    private val decoder = GrantVerifier(emptyList())

    internal suspend fun beginRefresh(): GrantRefreshTicket = db.recovery.commit {
        val token = db.recovery.token()
        val owner = token.owner.grantOwnerKey()
        val state = db.grantDao().state()
        require(state == null || state.ownerKey == owner)
        val previous = state?.requestedSequence ?: 0
        check(safe(previous) && previous < JS_MAX_SAFE_INTEGER)
        db.grantDao().state((state ?: emptyState(owner, token.generation)).copy(requestedSequence = previous + 1))
        GrantRefreshTicket(token, previous + 1)
    }

    internal suspend fun saveProvenance(kind: TaskKind, id: String, original: String) = db.recovery.commit {
        val token = db.recovery.token()
        db.grantDao().provenance(GrantTaskProvenanceEntity(kind.wire, id, token.owner.grantOwnerKey(), token.generation, original))
    }

    suspend fun start(kind: TaskKind, taskId: String, eventId: String) = admit(kind, taskId, eventId, null, emptyMap())

    suspend fun complete(kind: TaskKind, taskId: String, eventId: String, event: GrantEventType, units: Long? = null, containers: Long? = null, payload: String = eventId, executionFingerprint: String? = null) =
        admit(kind, taskId, eventId, event, grantEventCosts(event, units, containers), payload, executionFingerprint)

    private suspend fun admit(kind: TaskKind, taskId: String, eventId: String, event: GrantEventType?, costs: Map<String, Long>, payload: String = eventId, executionFingerprint: String? = null) = db.recovery.commit {
        require(kind != TaskKind.PICKUP && (event == null || event in setOf(GrantEventType.SHIFT_SCAN,GrantEventType.SHIFT_BOX_CLOSE,GrantEventType.SHIFT_PALLET_CLOSE,GrantEventType.SHIFT_LABEL_PREPARE,GrantEventType.SHIFT_CLOSE,GrantEventType.INVENTORY_SCAN,GrantEventType.INVENTORY_CLOSE))) { "Unsupported Handheld productive event" }
        if (event == null) app.markiro.handheld.core.replacement.ReplacementReadiness(db).requireAdmission(kind.wire, taskId)
        val token = db.recovery.token()
        val ownerKey = token.owner.grantOwnerKey()
        val dao = db.grantDao()
        val state = dao.state()
        val mode = state?.takeIf { it.ownerKey == ownerKey }?.mode ?: "observe"
        check(mode in setOf("observe", "strict"))
        val binding = dao.binding(ownerKey, kind.wire, taskId)
        val snapshot = binding?.snapshotDigest ?: "unbound"
        val costJson = JsonObject(costs.mapValues { JsonPrimitive(it.value) }).toString()
        val identity = grantDigest(JsonArray((listOf(kind.wire, taskId, event?.wire ?: "start", payload, costJson) + listOfNotNull(executionFingerprint)).map(::JsonPrimitive)).toString())
        val prior = dao.evidence(ownerKey, eventId)
        if (prior != null && (prior.reason == null || prior.mode == "observe")) {
            require(prior.payloadDigest == identity) { "Grant event identity conflict" }
            return@commit
        }
        val row = dao.token(grantSlot(ownerKey, if (event == null) "device" else kind.wire, if (event == null) "" else taskId))
        val retired = state?.let { Json.parseToJsonElement(it.retiredKids).jsonArray.map { x -> x.jsonPrimitive.content }.toSet() } ?: emptySet()
        val grant = row?.takeIf { it.ownerKey == ownerKey && it.generation == token.generation && it.epoch == state?.epoch && it.kid !in retired }?.let { runCatching { decoder.parseStored(it.compact) }.getOrNull() }
        val clockSample = sample()
        val assessment = state?.takeIf { it.ownerKey == ownerKey && it.generation == token.generation && it.clockValid }?.let {
            assessClock(TrustedClock(it.serverMs, it.monotonicMs, it.bootId, it.serverHighWater, it.wallHighWater), clockSample)
        }
        val now = (assessment as? ClockAssessment.Trusted)?.now
        val advanced = state?.copy(serverHighWater = maxOf(state.serverHighWater, now ?: state.serverHighWater), wallHighWater = maxOf(state.wallHighWater, clockSample.wallMs.coerceAtLeast(0)), clockValid = now != null)
        val owner = GrantOwner(token.owner.tenantId, token.owner.deviceId, DeviceKind.HANDHELD, state?.epoch ?: 0)
        val capability = when (kind) { TaskKind.SHIFT -> GrantCapability.SHIFT_START; TaskKind.INVENTORY -> GrantCapability.INVENTORY_START; TaskKind.PICKUP -> GrantCapability.PICKUP_START }
        val intent = GrantIntent(owner, capability, taskId, snapshot, eventId, event ?: GrantEventType.SHIFT_CLOSE, costs)
        val counters = dao.counters(ownerKey, kind.wire, taskId, snapshot).associate { it.budgetId to it.consumed }
        val decision = if (event == null) GrantAdmission.assessNewWork(grant as? DeviceGrant, intent, now)
            else if (binding != null && (binding.executionFingerprint != GrantTaskMatcher.fingerprint(db, kind, taskId) ||
                (executionFingerprint != null && executionFingerprint != binding.executionFingerprint))) LocalDecision.Deny(DenialReason.WRONG_TASK)
            else GrantAdmission.assessCompletion(grant as? TaskGrant, intent, now, counters)
        val evidence = GrantEvidenceEntity(ownerKey, eventId, kind.wire, taskId, snapshot, identity, costJson, grant?.grantId, row?.compact, mode, (decision as? LocalDecision.Deny)?.reason?.name, now, token.generation, state?.epoch ?: 0)
        if (mode == "strict" && decision != LocalDecision.Allow) throw GrantDenied(evidence, advanced)
        if (advanced != null) dao.state(advanced)
        for ((budget, cost) in costs) {
            val used = counters[budget] ?: 0
            check(safe(used) && cost <= JS_MAX_SAFE_INTEGER - used)
            dao.counter(GrantCounterEntity(ownerKey, kind.wire, taskId, snapshot, budget, used + cost))
        }
        dao.evidence(evidence)
        if (state?.ownerKey == ownerKey && state.epoch > 0) {
            db.metaDao().put(app.markiro.handheld.core.storage.MetaEntity(GrantEvidenceTransport.eventMarker(ownerKey, eventId), "offline-grants-v1"))
        }
    }

    /** Called only by the outer recovery transaction after rolling back the denied business effect. */
    internal suspend fun recordDenied(denied: GrantDenied) {
        val dao = db.grantDao()
        val current = dao.state()
        denied.clockState?.takeIf { current?.ownerKey == it.ownerKey && current.generation == it.generation }?.let { next ->
            dao.state(checkNotNull(current).copy(serverHighWater = maxOf(current.serverHighWater, next.serverHighWater), wallHighWater = maxOf(current.wallHighWater, next.wallHighWater), clockValid = current.clockValid && next.clockValid))
        }
        dao.evidence(denied.decision)
    }

    private fun emptyState(owner: String, generation: Long) = GrantStateEntity(ownerKey = owner, generation = generation, epoch = 0, mode = "observe", requestedSequence = 0, installedSequence = 0, keysetRevision = "", retiredKids = "[]", keysetJson = "{}", serverMs = 0, monotonicMs = 0, bootId = "", serverHighWater = 0, wallHighWater = 0, clockValid = false)
}
