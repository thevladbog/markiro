package app.markiro.handheld.core.grants

import app.markiro.handheld.BuildConfig
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.storage.HANDHELD_DATABASE_VERSION
import app.markiro.handheld.core.storage.HandheldDatabase
import kotlinx.serialization.json.*
import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.util.Base64
import java.util.UUID

/** Authenticated StationApi transport; verification happens before taking the recovery/Room lease. */
internal class GrantTransport(private val db: HandheldDatabase, private val api: StationApi) {
    suspend fun refreshConfiguredDevice(): Boolean {
        if(db.grantDao().state()?.keysetRevision.isNullOrEmpty()) return false
        return refreshIfAvailable()
    }
    suspend fun refreshConfiguredTask(kind: TaskKind, taskId: String): Boolean {
        if(db.grantDao().state()?.keysetRevision.isNullOrEmpty()) return false
        return refreshIfAvailable(kind,taskId)
    }
    suspend fun refreshIfAvailable(kind: TaskKind? = null, taskId: String? = null): Boolean = try {
        refresh(kind,taskId)
        true
    } catch (error: kotlinx.coroutines.CancellationException) { throw error }
      catch (_: java.io.IOException) { false }
      catch (_: retrofit2.HttpException) { false }
      catch (_: IllegalArgumentException) { false }
      catch (_: IllegalStateException) { false }
      catch (_: NoSuchElementException) { false }
      catch (_: ClassCastException) { false }
      catch (_: java.security.GeneralSecurityException) { false }

    suspend fun refresh(kind: TaskKind? = null, taskId: String? = null) = db.recovery.work {
        if (kind == null && app.markiro.handheld.core.replacement.ReplacementReadiness(db).blocked()) return@work
        val ticket = db.grants.beginRefresh()
        val requestClock = db.grants.sample()
        val negotiation = buildJsonObject {
            put("protocol", "offline-grants-v1")
            put("capability", "offline-grants-v1")
            put("requestId", UUID.randomUUID().toString())
        }
        val configuration = api.grantConfiguration(negotiation)
        require(configuration.keys == setOf("protocol", "owner", "serverTime", "mode", "policyRevision", "keyset"))
        require(configuration.string("protocol") == "offline-grants-v1")
        val epoch = verifyOwner(ticket, configuration.getValue("owner").jsonObject)
        val configuredMode = configuration.string("mode").also { require(it in setOf("observe", "strict")) }
        val policy = configuration.getValue("policyRevision").let { if(it == JsonNull) null else it.jsonPrimitive.also { p -> require(p.isString && p.content.isNotEmpty()) }.content }
        val serverTime = configuration.number("serverTime")
        val keyset = configuration.getValue("keyset").takeUnless { it == JsonNull }?.jsonObject
        val security = keyset?.let { verifyKeyset(ticket, it) }
        // Authenticated revocation is security state, independent of productive issuance.
        val current = db.recovery.commit(ticket.token) {
            val state = checkNotNull(db.grantDao().state())
            if (state.requestedSequence != ticket.sequence) return@commit false
            require(epoch >= state.epoch)
            val withKeys = if (keyset != null && security != null) {
                val retired = (Json.parseToJsonElement(state.retiredKids).jsonArray.map { it.jsonPrimitive.content } + security.retired).toSet()
                val historical = Json.parseToJsonElement(state.keysetJson).jsonObject["keys"]?.jsonArray.orEmpty()
                val incoming = keyset.getValue("keys").jsonArray.associateBy { it.jsonObject.string("kid") }
                historical.forEach { old ->
                    require(incoming[old.jsonObject.string("kid")] == null || incoming[old.jsonObject.string("kid")] == old) {
                        "Signing key identifier cannot change key material"
                    }
                }
                val merged = (historical + keyset.getValue("keys").jsonArray).associateBy { it.jsonObject.string("kid") }
                val saved = JsonObject(keyset + ("keys" to JsonArray(merged.values.toList())))
                state.copy(keysetRevision=keyset.string("revision"),
                    retiredKids=JsonArray(retired.sorted().map(::JsonPrimitive)).toString(), keysetJson=saved.toString())
            } else state
            // A missing policy is not an approved rollback of an existing strict policy.
            val mode = if (policy == null || app.markiro.handheld.core.replacement.ReplacementReadiness(db).blocked()) state.mode else configuredMode
            db.grantDao().state(anchor(withKeys, ticket, requestClock, serverTime).copy(epoch=epoch, mode=mode))
            true
        }
        if (!current) return@work
        checkNotNull(security) { "Offline grant signing is not configured" }
        val body = buildJsonObject {
            negotiation.forEach { (key,value) -> put(key,value) }
            if(kind != null) { require(kind != TaskKind.PICKUP); put("taskKind",kind.wire); put("taskId",checkNotNull(taskId)) }
        }
        val result = if(kind == null) api.deviceGrant(body) else api.taskGrant(body)
        when (result.string("status")) {
            "denied" -> {
                require(result.keys == setOf("status", "reason") && result.string("reason").isNotEmpty())
                error("Offline grant issuance denied")
            }
            "issued" -> require(result.keys == setOf("status", "envelope"))
            else -> error("Invalid offline grant result")
        }
        val envelope = result.getValue("envelope").jsonObject
        val verified = verifyEnvelope(ticket, security, envelope)
        db.recovery.commit(ticket.token) {
            val state = checkNotNull(db.grantDao().state())
            // A later-started refresh wins even when it has not returned yet.
            if(state.requestedSequence != ticket.sequence || state.installedSequence >= ticket.sequence) return@commit
            require(verified.epoch == state.epoch)
            val retired = (Json.parseToJsonElement(state.retiredKids).jsonArray.map { it.jsonPrimitive.content } + verified.retired).toSet()
            require(verified.tokens.none { it.kid in retired })
            val bindings = verified.snapshots.map { (grant, canonical) ->
                GrantTaskMatcher.bind(db, state.ownerKey, grant.taskKind, grant.taskId, grant.snapshotDigest, canonical)
            }
            // Configuration owns mode; an issuance envelope cannot undo its recovery decision.
            db.grantDao().state(anchor(state, ticket, requestClock, verified.serverTime).copy(installedSequence=ticket.sequence))
            bindings.forEach { binding ->
                val previous = db.grantDao().binding(binding.ownerKey,binding.taskKind,binding.taskId)
                if (previous == null || previous.snapshotDigest != binding.snapshotDigest) {
                    // A task grant only authorizes completion. A first or changed frozen scope is
                    // new work; authorize it atomically before replacing the binding.
                    db.grants.start(verified.snapshots.single { it.first.taskId == binding.taskId && it.first.taskKind.wire == binding.taskKind }.first.taskKind,
                        binding.taskId, "task.binding:${ticket.sequence}:${binding.taskKind}:${binding.taskId}:${binding.snapshotDigest}")
                }
                // Work observed before first issuance still consumes this task's first authenticated budget.
                if(db.grantDao().binding(binding.ownerKey,binding.taskKind,binding.taskId) == null) {
                    val prior=db.grantDao().counters(binding.ownerKey,binding.taskKind,binding.taskId,"unbound")
                    val current=db.grantDao().counters(binding.ownerKey,binding.taskKind,binding.taskId,binding.snapshotDigest).associateBy { it.budgetId }
                    prior.forEach { cost ->
                        val used=current[cost.budgetId]?.consumed ?: 0
                        require(safe(used) && safe(cost.consumed) && cost.consumed <= JS_MAX_SAFE_INTEGER-used)
                        db.grantDao().counter(cost.copy(snapshotDigest=binding.snapshotDigest,consumed=used+cost.consumed))
                    }
                }
                db.grantDao().binding(binding)
            }
            verified.tokens.filter { it.taskKind != "device" || !app.markiro.handheld.core.replacement.ReplacementReadiness(db).blocked() }.forEach { db.grantDao().token(it) }
            if (kind == null) {
                val deviceGrantId = checkNotNull(verified.deviceGrantId)
                val requestId = UUID.randomUUID().toString()
                val body = buildJsonObject {
                    put("protocol", "offline-grants-v1")
                    put("capability", "offline-grants-readiness-v1")
                    put("requestId", requestId)
                    put("clientBuild", "handheld:${BuildConfig.VERSION_NAME}")
                    put("storageRevision", HANDHELD_DATABASE_VERSION)
                    put("installed", buildJsonObject {
                        put("mode", state.mode)
                        put("policyRevision", policy?.let(::JsonPrimitive) ?: JsonNull)
                        put("keysetRevision", state.keysetRevision)
                        put("verifiedGrantId", deviceGrantId)
                    })
                }
                db.grantDao().readiness(
                    GrantReadinessOutboxEntity(requestId, state.ownerKey, ticket.token.generation, body.toString()),
                )
            }
        }
    }

    suspend fun flushReadinessIfAvailable(): Boolean = try {
        flushReadiness()
    } catch (error: kotlinx.coroutines.CancellationException) { throw error }
      catch (_: java.io.IOException) { false }
      catch (_: retrofit2.HttpException) { false }
      catch (_: IllegalArgumentException) { false }
      catch (_: IllegalStateException) { false }
      catch (_: NoSuchElementException) { false }
      catch (_: ClassCastException) { false }

    suspend fun flushReadiness(): Boolean = db.recovery.work {
        val token = db.recovery.token()
        val owner = token.owner.grantOwnerKey()
        var acknowledged = false
        for (row in db.grantDao().pendingReadiness(owner, token.generation)) {
            val body = readinessBody(row)
            val admitted = db.recovery.commit(token) {
                db.grantDao().markReadinessAttempt(row.requestId, owner, token.generation) == 1
            }
            if (!admitted || !db.recovery.valid(token)) continue
            val response = api.grantReadiness(body)
            require(response.keys == setOf("protocol", "requestId", "receivedAt", "accepted", "matchesCurrentConfiguration", "verifiedGrantMatched"))
            require(response.string("protocol") == "offline-grants-v1")
            require(response.string("requestId") == row.requestId)
            require(response.string("receivedAt").isNotEmpty())
            require(response.getValue("accepted").jsonPrimitive.boolean)
            response.getValue("matchesCurrentConfiguration").jsonPrimitive.boolean
            response.getValue("verifiedGrantMatched").jsonPrimitive.boolean
            acknowledged = db.recovery.commit(token) {
                db.grantDao().acknowledgeReadiness(row.requestId, owner, token.generation) == 1
            } || acknowledged
        }
        acknowledged
    }

    private fun readinessBody(row: GrantReadinessOutboxEntity): JsonObject {
        val body = Json.parseToJsonElement(row.bodyJson).jsonObject
        require(body.keys == setOf("protocol", "capability", "requestId", "clientBuild", "storageRevision", "installed"))
        require(body.string("protocol") == "offline-grants-v1")
        require(body.string("capability") == "offline-grants-readiness-v1")
        require(body.string("requestId") == row.requestId && UUID.fromString(row.requestId).toString() == row.requestId)
        require(body.string("clientBuild").isNotEmpty())
        require(body.number("storageRevision") in 1..HANDHELD_DATABASE_VERSION.toLong())
        val installed = body.getValue("installed").jsonObject
        require(installed.keys == setOf("mode", "policyRevision", "keysetRevision", "verifiedGrantId"))
        require(installed.string("mode") in setOf("observe", "strict"))
        installed["policyRevision"]?.takeUnless { it == JsonNull }?.jsonPrimitive?.also { require(it.isString && it.content.isNotEmpty()) }
        require(installed.string("keysetRevision").isNotEmpty())
        require(UUID.fromString(installed.string("verifiedGrantId")).toString() == installed.string("verifiedGrantId"))
        return body
    }

    private fun anchor(state: GrantStateEntity, ticket: GrantRefreshTicket, requestClock: ClockSample, serverTime: Long): GrantStateEntity {
        val clock = db.grants.sample()
        require(safe(clock.monotonicMs) && safe(clock.wallMs))
        // Counting the entire request interval can shorten authority, never extend it.
        val sameSession = requestClock.bootId.isNotEmpty() && clock.bootId == requestClock.bootId &&
            safe(requestClock.monotonicMs) && clock.monotonicMs >= requestClock.monotonicMs
        val elapsed = if (sameSession) clock.monotonicMs-requestClock.monotonicMs else 0
        val bounded = sameSession && elapsed <= JS_MAX_SAFE_INTEGER-serverTime
        val now = if (bounded) serverTime+elapsed else serverTime
        // Clock distrust must not discard authenticated retirement or an approved
        // recovery configuration. Preserve the high-water and deny productive trust.
        val nondecreasing = now >= state.serverHighWater
        val highWater = maxOf(now, state.serverHighWater)
        return state.copy(generation=ticket.token.generation, serverMs=highWater, monotonicMs=clock.monotonicMs,
            bootId=clock.bootId, serverHighWater=highWater, wallHighWater=clock.wallMs, clockValid=bounded && nondecreasing)
    }

    private fun verifyOwner(ticket: GrantRefreshTicket, owner: JsonObject): Long {
        require(owner.keys == setOf("tenantId","deviceId","kind","credentialEpoch"))
        require(owner.string("tenantId") == ticket.token.owner.tenantId && owner.string("deviceId") == ticket.token.owner.deviceId && owner.string("kind") == ticket.token.owner.kind && ticket.token.owner.kind == "handheld")
        return owner.number("credentialEpoch").also { require(it > 0) }
    }

    private data class Envelope(val epoch: Long, val mode: String, val serverTime: Long, val retired: Set<String>, val tokens: List<GrantTokenEntity>, val snapshots: List<Pair<TaskGrant,String>>, val deviceGrantId: String?)
    private data class Keyset(val keys: List<VerificationKey>, val retired: Set<String>)
    private fun verifyKeyset(ticket: GrantRefreshTicket, keyset: JsonObject): Keyset {
        val origin = ticket.token.owner.serverOrigin
        require(keyset.keys == setOf("protocol","origin","revision","keys","retiredKids"))
        require(keyset.string("protocol") == "offline-grants-v1" && keyset.string("origin") == origin && keyset.string("revision").isNotEmpty())
        val retired = keyset.getValue("retiredKids").jsonArray.map { it.jsonPrimitive.also { p -> require(p.isString && p.content.isNotEmpty()) }.content }.toSet()
        val keys = keyset.getValue("keys").jsonArray.map { item ->
            val row = item.jsonObject; require(row.keys == setOf("kid","jwk")); val kid = row.string("kid"); require(kid.isNotEmpty())
            val jwk = row.getValue("jwk").jsonObject
            require(jwk.keys.containsAll(setOf("kty","crv","x","y")) && jwk.keys.all { it in setOf("kty","crv","x","y","alg","use") })
            require(jwk.string("kty") == "EC" && jwk.string("crv") == "P-256")
            require(jwk["alg"] == null || jwk["alg"] == JsonPrimitive("ES256")); require(jwk["use"] == null || jwk["use"] == JsonPrimitive("sig"))
            fun coordinate(name: String): BigInteger {
                val text = jwk.string(name); require(text.matches(Regex("[A-Za-z0-9_-]{43}")))
                val bytes = Base64.getUrlDecoder().decode(text); require(bytes.size == 32 && Base64.getUrlEncoder().withoutPadding().encodeToString(bytes) == text)
                return BigInteger(1,bytes)
            }
            val params = AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }.getParameterSpec(ECParameterSpec::class.java)
            val key = KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(ECPoint(coordinate("x"),coordinate("y")),params))
            VerificationKey(kid,origin,key.encoded)
        }
        require(keys.map { it.kid }.toSet().size == keys.size)
        return Keyset(keys, retired)
    }

    private fun verifyEnvelope(ticket: GrantRefreshTicket, security: Keyset, envelope: JsonObject): Envelope {
        val origin = ticket.token.owner.serverOrigin
        val retired = security.retired
        val keys = security.keys
        require(envelope.keys == setOf("protocol","serverTime","owner","mode","grants","taskSnapshots"))
        require(envelope.string("protocol") == "offline-grants-v1")
        val epoch = verifyOwner(ticket, envelope.getValue("owner").jsonObject)
        val mode = envelope.string("mode"); require(mode in setOf("observe","strict"))
        val serverTime = envelope.number("serverTime")
        val verifier = GrantVerifier(keys.filter { it.kid !in retired })
        val grants = envelope.getValue("grants").jsonArray.map { raw ->
            val compact = raw.jsonPrimitive.also { require(it.isString) }.content
            val grant = (verifier.verify(compact,origin) as? VerifiedGrantResult.Valid)?.grant ?: error("Invalid offline grant")
            require(grant.owner == GrantOwner(ticket.token.owner.tenantId,ticket.token.owner.deviceId,DeviceKind.HANDHELD,epoch))
            val header = Json.parseToJsonElement(String(Base64.getUrlDecoder().decode(compact.substringBefore('.')),Charsets.UTF_8)).jsonObject
            grant to (header.string("kid") to compact)
        }
        val snapshots = envelope.getValue("taskSnapshots").jsonArray.map { raw ->
            val row = raw.jsonObject; require(row.keys == setOf("taskKind","taskId","snapshotDigest","canonical"))
            val grant = grants.map { it.first }.filterIsInstance<TaskGrant>().single { it.taskKind.wire == row.string("taskKind") && it.taskId == row.string("taskId") && it.snapshotDigest == row.string("snapshotDigest") }
            val canonical = row.string("canonical"); require(grantDigest(canonical) == grant.snapshotDigest)
            grant to canonical
        }
        require(snapshots.size == grants.count { it.first is TaskGrant } && snapshots.map { it.first.taskId to it.first.taskKind }.toSet().size == snapshots.size)
        val ownerKey = ticket.token.owner.grantOwnerKey()
        val tokens = grants.map { (grant, signed) ->
            val task = grant as? TaskGrant
            GrantTokenEntity(grantSlot(ownerKey,task?.taskKind?.wire ?: "device",task?.taskId ?: ""),ownerKey,ticket.token.generation,epoch,task?.taskKind?.wire ?: "device",task?.taskId ?: "",task?.snapshotDigest ?: "",signed.first,signed.second)
        }
        require(tokens.map { it.slot }.toSet().size == tokens.size)
        return Envelope(epoch,mode,serverTime,retired,tokens,snapshots,grants.map { it.first }.filterIsInstance<DeviceGrant>().singleOrNull()?.grantId)
    }
    private fun JsonObject.string(name: String) = getValue(name).jsonPrimitive.also { require(it.isString) }.content
    private fun JsonObject.number(name: String) = getValue(name).jsonPrimitive.also { require(!it.isString) }.long.also { require(safe(it)) }
}
