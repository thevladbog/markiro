package app.markiro.handheld.core.replacement

import androidx.room.withTransaction
import app.markiro.handheld.BuildConfig
import app.markiro.handheld.core.grants.grantDigest
import app.markiro.handheld.core.grants.grantOwnerKey
import app.markiro.handheld.core.storage.*
import kotlinx.serialization.json.*
import java.time.Instant
import java.util.UUID

/** All state transitions share the credential-generation and Room business commit boundary. */
class ReplacementReadiness(private val db: HandheldDatabase) {
    suspend fun blocked(): Boolean = ReplacementEvidenceRecoveryState(db).blocked() || ReplacementTarget(db).blocked() || db.replacementDao().get()?.blocked == true
    suspend fun requireAdmission(kind: String? = null, taskId: String? = null) {
        if(ReplacementEvidenceRecoveryState(db).blocked()) throw ReplacementDenied()
        if (ReplacementTarget(db).blocked()) throw ReplacementDenied()
        val row = db.replacementDao().get() ?: return
        if (!row.blocked) return
        val token = db.recovery.token()
        val admitted = Json.parseToJsonElement(row.resumeTasksJson).jsonArray.any {
            it.jsonObject.text("kind") == kind && it.jsonObject.text("taskId") == taskId
        }
        if (row.ownerKey != token.owner.grantOwnerKey() || row.generation != token.generation || row.state == "closed" || !admitted) throw ReplacementDenied()
    }
    private suspend fun owned(token: GenerationToken, allowSettledGeneration: Boolean = false): ReplacementDrainEntity? {
        check(db.recovery.valid(token))
        return db.replacementDao().get()?.also { require(it.ownerKey == token.owner.grantOwnerKey() && (it.generation == token.generation || allowSettledGeneration && !it.blocked)) { "Replacement credential changed" } }
    }
    private suspend fun fence() {
        db.replacementDao().retireDeviceGrants()
        db.grantDao().state()?.let { state ->
            check(state.requestedSequence < 9_007_199_254_740_991)
            db.grantDao().state(state.copy(requestedSequence=state.requestedSequence+1))
        }
    }
    suspend fun apply(token: GenerationToken, projection: JsonObject?) = db.recovery.commit(token) {
        val current = owned(token, allowSettledGeneration = true)
        if (projection == null) return@commit
        require(projection.number("version") == 1L)
        when (projection.text("state")) {
            "none" -> require(projection.keys == setOf("version","state"))
            "active" -> {
                require(projection.keys == setOf("version","state","intent"))
                val intent = projection.getValue("intent").jsonObject
                validateIntent(intent)
                db.grantDao().state()?.takeIf { it.epoch > 0 }?.let { require(it.epoch <= intent.number("credentialEpoch")) }
                if (current != null) {
                    val old = Json.parseToJsonElement(current.intentJson).jsonObject
                    if (old == intent) return@commit
                    if (current.state == "closed" || current.closureJson != null && current.acknowledgedAt == null || current.reportJson != null) return@commit
                    if (intent.number("credentialEpoch") != old.number("credentialEpoch")) {
                        require(current.generation != token.generation && !current.blocked && intent.number("credentialEpoch") > old.number("credentialEpoch")) { "Replacement epoch changed" }
                    }
                    if (current.closureJson != null) {
                        val tombstone = Json.parseToJsonElement(current.closureJson).jsonObject.getValue("tombstone").jsonObject
                        if (intent.text("preparationId") == tombstone.text("preparationId") || Instant.parse(intent.text("requestedAt")) <= Instant.parse(tombstone.text("closedAt"))) return@commit
                    } else if (Instant.parse(intent.text("requestedAt")) <= Instant.parse(old.text("requestedAt"))) return@commit
                }
                val tasks = if (current?.blocked == true) current.resumeTasksJson else activeTasks().toString()
                db.replacementDao().put(ReplacementDrainEntity(ownerKey=token.owner.grantOwnerKey(),generation=token.generation,intentJson=intent.toString(),resumeTasksJson=tasks,reportSequence=current?.reportSequence ?: 0))
                fence()
            }
            "cancelled", "closed" -> {
                validateClosure(projection)
                val row = current ?: return@commit
                require(row.generation == token.generation) { "Replacement credential changed" }
                val intent = Json.parseToJsonElement(row.intentJson).jsonObject
                require(listOf("intentId","preparationId","credentialEpoch").all { intent[it] == projection[it] })
                require(projection.number("preparationRevision") > intent.number("preparationRevision"))
                require(Instant.parse(projection.text("closedAt")) >= Instant.parse(intent.text("requestedAt")))
                if (row.closureJson != null) {
                    require(Json.parseToJsonElement(row.closureJson).jsonObject["tombstone"] == projection)
                    return@commit
                }
                val body = buildJsonObject { put("requestId",UUID.randomUUID().toString()); put("tombstone",projection) }
                db.replacementDao().put(row.copy(state=projection.text("state"),closureJson=body.toString(),reportJson=null))
                fence()
            }
            else -> error("Unknown replacement projection")
        }
    }
    suspend fun pendingClosure(token: GenerationToken): JsonObject? = db.recovery.commit(token) {
        owned(token, allowSettledGeneration = true)?.takeIf { it.generation == token.generation && it.acknowledgedAt == null }?.closureJson?.let { Json.parseToJsonElement(it).jsonObject }
    }
    suspend fun acknowledgeClosure(token: GenerationToken, body: JsonObject, response: JsonObject) = db.recovery.commit(token) {
        require(response.keys == setOf("requestId","tombstone","acknowledgedAt"))
        require(response["requestId"] == body["requestId"] && response["tombstone"] == body["tombstone"])
        Instant.parse(response.text("acknowledgedAt"))
        val row = checkNotNull(owned(token))
        require(row.closureJson == body.toString())
        db.replacementDao().put(row.copy(acknowledgedAt=response.text("acknowledgedAt")))
        fence()
        check(db.replacementDao().get()?.acknowledgedAt == response.text("acknowledgedAt"))
    }
    suspend fun prepareReport(token: GenerationToken): JsonObject = db.recovery.commit(token) {
        val row = checkNotNull(owned(token)); check(row.state == "active")
        row.reportJson?.let { return@commit Json.parseToJsonElement(it).jsonObject }
        val intent = Json.parseToJsonElement(row.intentJson).jsonObject
        val snapshot = snapshot()
        val sequence = highestSequence()
        val revision = (db.metaDao().get(REVISION)?.toLongOrNull() ?: 1).coerceAtLeast(1)
        val body = buildJsonObject {
            put("requestId",UUID.randomUUID().toString()); put("intentId",intent.getValue("intentId")); put("credentialEpoch",intent.getValue("credentialEpoch"))
            put("reportSequence",row.reportSequence+1); put("clientBuild","handheld:${BuildConfig.VERSION_NAME}"); put("storageRevision",revision)
            snapshot.forEach { (k,v) -> put(k,v) }
            put("journal",buildJsonObject { put("digest",grantDigest("$revision:$sequence:" + snapshot.toString())); put("highestSequence",sequence) })
        }
        db.replacementDao().put(row.copy(reportSequence=row.reportSequence+1,reportJson=body.toString()))
        body
    }
    suspend fun acknowledgeReport(token: GenerationToken, body: JsonObject, response: JsonObject) = db.recovery.commit(token) {
        require(response.keys == setOf("requestId","intentId","receivedAt","unsupportedChannels","eligibility"))
        require(response["requestId"] == body["requestId"] && response["intentId"] == body["intentId"])
        Instant.parse(response.text("receivedAt"))
        val eligibility = response.getValue("eligibility").jsonObject
        require(eligibility.text("status") in setOf("eligible","blocked"))
        require(eligibility.getValue("reasons") is JsonArray && response.getValue("unsupportedChannels") is JsonArray)
        val row = checkNotNull(owned(token)); require(row.reportJson == body.toString())
        db.replacementDao().put(row.copy(reportJson=null))
    }
    suspend fun snapshot(): JsonObject = try { db.withTransaction {
        buildJsonObject {
            put("pending",buildJsonObject {
                put("scans",count("outbox") + db.validationDao().pendingCountNow())
                put("inventories",count("inventory_outbox"))
                put("shiftClosures",count("shift_close_outbox","state <> 'accepted'"))
                put("productLabels",count("product_label_events","ackedAt IS NULL") + count("product_label_jobs","status <> 'completed'"))
                put("boxes",count("boxes","disassembledAt IS NULL AND (closedAt IS NULL OR ackedAt IS NULL OR printState <> 'printed')") + count("pallets","closedAt IS NULL OR ackedAt IS NULL OR printState <> 'printed'")+count("pallet_memberships","status IN ('pending','sent')")+count("pallet_membership_removals"))
                put("exceptions",count("box_exceptions","ackedAt IS NULL")+count("pallet_exceptions","ackedAt IS NULL")+count("writeoff_outbox","state = 'pending'")+retainedEvidence())
            })
            put("conflicts",count("conflicts_mirror")+count("pallet_memberships","status = 'rejected' AND acknowledgedAt IS NULL")+count("product_label_events","quarantineCode IS NOT NULL")+count("shift_close_outbox","state = 'conflict'")+count("inventory_events","serverStatus IN ('conflict','quarantined','rejected')"))
            put("unknownPrints",count("boxes","disassembledAt IS NULL AND printState IN ('printing','unknown')")+count("pallets","printState IN ('printing','unknown')")+count("product_label_jobs","status <> 'completed' AND attemptState IN ('sending','delivery_unknown')"))
            put("activeTasks",activeTasks())
            // Device authority is retired atomically; task grants remain available for recovery.
            put("installedGrants",JsonArray(db.openHelper.readableDatabase.query("SELECT compact FROM grant_tokens ORDER BY slot").use { rows ->
                buildList { while(rows.moveToNext()) {
                    val payload = String(java.util.Base64.getUrlDecoder().decode(rows.getString(0).split('.')[1]),Charsets.UTF_8)
                    add(buildJsonObject { put("grantId",Json.parseToJsonElement(payload).jsonObject.getValue("grantId")) })
                } }
            }))
        }
    }
    } catch (failure: android.database.sqlite.SQLiteException) {
        if (!missingSchema(failure)) throw failure
        buildJsonObject {
            put("pending",buildJsonObject {
                for (channel in listOf("scans","inventories","shiftClosures","productLabels","boxes","exceptions")) put(channel,"unsupported")
            })
            put("conflicts","unsupported"); put("unknownPrints","unsupported")
            put("activeTasks",JsonArray(emptyList())); put("installedGrants",JsonArray(emptyList()))
        }
    }
    /** Original grant envelopes are retained after delivery; only unfinished receipt state blocks. */
    private fun retainedEvidence(): Long {
        val sql = db.openHelper.readableDatabase
        val evidence = sql.query("SELECT key,value FROM meta WHERE key LIKE 'grant_transport:%'").use { rows ->
            buildMap<String,String> { while (rows.moveToNext()) put(rows.getString(0),rows.getString(1)) }
        }
        val unfinished = evidence.entries.count { (key,value) ->
            if (key.endsWith(":receipt")) false else {
                val request = Json.parseToJsonElement(value).jsonObject
                if (request["negotiated"] == JsonPrimitive(false)) false else {
                    val receipt = evidence[key+":receipt"]?.let { Json.parseToJsonElement(it).jsonObject }
                    val outcome = receipt?.get("outcome")?.jsonPrimitive?.content
                    val reconciliation = receipt?.get("reconciliation")?.jsonObject?.get("status")?.jsonPrimitive?.content
                    outcome !in setOf("accepted","duplicate") || reconciliation !in setOf("applied","rejected")
                }
            }
        }
        return unfinished.toLong() + count("meta", "key LIKE 'inventory_pending_batch:%' OR key = 'sync_pending_batch_id'")
    }
    private fun activeTasks(): JsonArray = JsonArray(buildList {
        for ((kind,sql) in listOf("shift" to "SELECT id FROM shift_mirror WHERE enteredAt IS NOT NULL AND leftAt IS NULL AND status <> 'closed'", "inventory" to "SELECT inventoryId FROM inventory_tasks WHERE state IN ('active','staging') AND leftAt IS NULL")) {
            db.openHelper.readableDatabase.query(sql).use { rows -> while(rows.moveToNext()) add(buildJsonObject { put("kind",kind); put("taskId",rows.getString(0)) }) }
        }
    }.sortedBy { it.toString() })
    internal fun highestSequence(): Long = try { db.openHelper.readableDatabase.query(
        "SELECT COALESCE(MAX(sequence),0) FROM (SELECT seq AS sequence FROM sqlite_sequence " +
            "UNION ALL SELECT deviceSequence FROM inventory_events UNION ALL SELECT nextDeviceSequence-1 FROM inventory_terminal_state " +
            "UNION ALL SELECT sequence FROM product_label_events UNION ALL SELECT deviceSeq FROM writeoff_outbox)",
    ).use { it.moveToFirst(); it.getLong(0) }
    } catch (failure: android.database.sqlite.SQLiteException) {
        if (!missingSchema(failure)) throw failure
        0
    }
    private fun count(table: String, where: String = "1") = db.openHelper.readableDatabase.query("SELECT COUNT(*) FROM $table WHERE $where").use { it.moveToFirst(); it.getLong(0) }
    companion object { const val REVISION = "replacement.storage_revision" }
}

private fun missingSchema(failure: android.database.sqlite.SQLiteException): Boolean =
    failure.message?.let { "no such table" in it || "no such column" in it } == true
internal fun JsonObject.text(key: String) = getValue(key).jsonPrimitive.also { require(it.isString) }.content
internal fun JsonObject.number(key: String) = getValue(key).jsonPrimitive.also { require(!it.isString) }.long.also { require(it in 1..9_007_199_254_740_991) }
private fun validateId(value: String) { require(UUID.fromString(value).toString() == value) }
private fun validateIntent(value: JsonObject) {
    require(value.keys == setOf("intentId","preparationId","credentialEpoch","preparationRevision","requestedAt","expiresAt"))
    validateId(value.text("intentId")); validateId(value.text("preparationId")); value.number("credentialEpoch"); value.number("preparationRevision")
    require(Instant.parse(value.text("expiresAt")) > Instant.parse(value.text("requestedAt")))
}
private fun validateClosure(value: JsonObject) {
    require(value.keys == setOf("version","state","intentId","preparationId","credentialEpoch","preparationRevision","closedAt"))
    validateId(value.text("intentId")); validateId(value.text("preparationId")); value.number("credentialEpoch"); value.number("preparationRevision"); Instant.parse(value.text("closedAt"))
}
