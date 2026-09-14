package app.markiro.handheld.core.grants

import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.ShiftEntity
import kotlinx.serialization.json.*

/** Only executed facts enter this projection. Mutable progress/status and historical print bytes do not. */
internal object GrantTaskMatcher {
    private fun value(v: Any?): JsonElement = when(v) {
        null -> JsonNull
        is Boolean -> JsonPrimitive(v)
        is Number -> JsonPrimitive(v)
        is JsonElement -> v
        else -> JsonPrimitive(v.toString())
    }
    private fun obj(vararg values: Pair<String, Any?>) = JsonObject(values.associate { it.first to value(it.second) })
    private fun spec(text: String?) = text?.let(Json::parseToJsonElement) ?: JsonNull
    suspend fun projection(db: HandheldDatabase, kind: TaskKind, id: String): JsonObject? = when(kind) {
        TaskKind.SHIFT -> db.shiftDao().get(id)?.let(::projection)
        TaskKind.INVENTORY -> db.inventoryTaskDao().get(id)?.let { s -> obj(
            "inventoryId" to s.inventoryId, "inventoryNumber" to s.inventoryNumber, "productId" to s.productId,
            "productName" to s.productName, "productPrintName" to s.productPrintName, "gtin14" to s.gtin14,
            "mode" to s.mode, "lineId" to s.lineId, "lineName" to s.lineName, "productionDateFrom" to s.productionDateFrom,
            "productionDateTo" to s.productionDateTo, "boxCapacity" to s.boxCapacity, "snapshotId" to s.snapshotId,
            "snapshotFixedAt" to s.snapshotFixedAt, "contentDigest" to s.contentDigest, "combinedDigest" to s.combinedDigest, "codeCount" to s.codeCount)
        }
        TaskKind.PICKUP -> null
    }
    fun projection(s: ShiftEntity): JsonObject = obj(
            "id" to s.id, "number" to s.number, "mode" to s.mode, "productId" to s.productId,
            "productName" to s.productName, "productPrintName" to s.productPrintName, "gtin14" to s.productGtin14,
            "lineId" to s.lineId, "lineName" to s.lineName, "counterpartyName" to s.counterpartyName, "plannedQty" to s.plannedQty, "plannedDate" to s.plannedDate, "productionDate" to s.productionDate,
            "boxCapacity" to s.boxCapacity, "palletsEnabled" to s.palletsEnabled, "palletBoxCapacity" to s.palletBoxCapacity,
            "validationPrintMode" to s.validationPrintMode, "allowPreviouslyAcceptedCodes" to s.allowPreviouslyAcceptedCodes, "validationPrintVerification" to s.duplicateVerification,
            "validationPrintPolicyRevision" to s.duplicatePolicyRevision, "duplicateTemplateDigest" to s.duplicateTemplateDigest,
            "duplicateTemplate" to spec(s.duplicateTemplate), "boxTemplate" to spec(s.boxLabelTemplate), "palletTemplate" to spec(s.palletLabelTemplateSpec),
            "shelfLifeDays" to s.shelfLifeDays, "egaisCode" to s.egaisCode, "ssccIssuerPrefix" to s.ssccIssuerPrefix,
            "stationClosePolicy" to s.closePolicyKind, "stationCloseOwnerDeviceId" to s.closeOwnerDeviceId)
    fun fingerprint(s: ShiftEntity): String = try {
        grantDigest(projection(s).toString())
    } catch (_: IllegalArgumentException) {
        // Legacy observe-mode scans must not fail because an unused print template
        // is malformed. This non-digest can never match an authenticated binding.
        "invalid-execution-snapshot"
    }

    suspend fun fingerprint(db: HandheldDatabase, kind: TaskKind, id: String): String? = projection(db,kind,id)?.let { grantDigest(it.toString()) }

    suspend fun bind(db: HandheldDatabase, owner: String, kind: TaskKind, id: String, digest: String, canonical: String): GrantTaskBindingEntity {
        require(grantDigest(canonical) == digest)
        val root = Json.parseToJsonElement(canonical).jsonObject
        require(root.keys == setOf("taskKind", "taskId", "scope") && root["taskKind"] == JsonPrimitive(kind.wire) && root["taskId"] == JsonPrimitive(id))
        val scope = root.getValue("scope").jsonObject
        val local = checkNotNull(projection(db,kind,id))
        val provenance = checkNotNull(db.grantDao().provenance(kind.wire,id))
        require(provenance.ownerKey == owner)
        val original = Json.parseToJsonElement(provenance.original).jsonObject
        fun same(key: String, source: JsonObject, sourceKey: String = key) {
            require(local.getValue(key) == (source[sourceKey] ?: JsonNull)) { "Frozen execution fact differs: $key" }
        }
        when(kind) {
            TaskKind.INVENTORY -> {
                require(scope.keys == setOf("manifest","snapshotId","combinedDigest","contentDigest"))
                val manifest = scope.getValue("manifest").jsonObject
                require(manifest.keys == local.keys + setOf("snapshotRevision","egaisCode","shelfLifeDays","boxLabelTemplate","limits"))
                require(manifest["snapshotRevision"] == JsonPrimitive(1) && manifest["boxLabelTemplate"] == JsonNull)
                val limits=manifest.getValue("limits").jsonObject
                require(limits.keys == setOf("codePageSize","eventBatchSize","progressPageSize") && limits.values.all { it.jsonPrimitive.int > 0 })
                require(local["mode"] == JsonPrimitive("check"))
                local.keys.forEach { same(it,manifest); same(it,original) }
                listOf("snapshotId","combinedDigest","contentDigest").forEach { same(it,scope) }
            }
            TaskKind.SHIFT -> {
                require(scope.keys == setOf("shift","product","templates"))
                val shift = scope.getValue("shift").jsonObject
                require(shift.keys == setOf("id","productId","mode","lineId","counterpartyId","counterpartyName","ssccIssuerCounterpartyId","labelTemplateId","boxLabelTemplateId","palletLabelTemplateId","validationPrintMode","allowPreviouslyAcceptedCodes","validationPrintVerification","validationPrintTemplateId","validationPrintSnapshot","validationPrintPolicyRevision","boxCapacity","palletsEnabled","palletBoxCapacity","stationClosePolicy","stationCloseOwnerDeviceId","plannedDate","productionDate","numberMonthKey","numberSeq","createdFrom"))
                val product = scope.getValue("product").jsonObject
                require(product.keys == setOf("id","gtin14","name","printName","chzProductGroupCode","egaisCode","shelfLifeDays"))
                val bundleShift = original.getValue("shift").jsonObject
                listOf("counterpartyId","ssccIssuerCounterpartyId","boxLabelTemplateId","palletLabelTemplateId","createdFrom").forEach { key ->
                    require(bundleShift.containsKey(key) && bundleShift[key] != JsonPrimitive("missing-offline-grant-fact") && bundleShift[key] == shift[key])
                }
                listOf("lineName","counterpartyName","plannedQty").forEach { same(it,bundleShift) }
                listOf("id","mode","productId","lineId","plannedDate","productionDate","boxCapacity","palletsEnabled","palletBoxCapacity","validationPrintMode","allowPreviouslyAcceptedCodes","validationPrintVerification","validationPrintPolicyRevision","stationClosePolicy","stationCloseOwnerDeviceId","counterpartyName").forEach { same(it,shift) }
                same("productId",product,"id"); same("productName",product,"name"); same("productPrintName",product,"printName")
                listOf("gtin14","shelfLifeDays","egaisCode").forEach { same(it,product) }
                val number = shift.getValue("numberMonthKey").jsonPrimitive.content + "-" + shift.getValue("numberSeq").jsonPrimitive.content.padStart(3,'0') + if(shift["createdFrom"] == JsonPrimitive("station")) "/S" else ""
                require(local["number"] == JsonPrimitive(number))
                val templates = scope.getValue("templates").jsonArray.map { it.jsonObject.also { row -> require(row.keys == setOf("id","spec")) } }.associate { it.getValue("id") to it.getValue("spec") }
                require(templates.size == scope.getValue("templates").jsonArray.size)
                fun template(localKey: String, idKey: String, bundleKey: String) {
                    val templateId = shift[idKey] ?: JsonNull
                    val expected = if(templateId == JsonNull) JsonNull else checkNotNull(templates[templateId])
                    require(local[localKey] == expected)
                    val received = original[bundleKey]?.takeUnless { it == JsonNull }?.jsonObject
                    require((received?.get("spec") ?: JsonNull) == expected)
                    require((received?.get("id") ?: JsonNull) == templateId)
                }
                template("boxTemplate","boxLabelTemplateId","boxLabelTemplate")
                template("palletTemplate","palletLabelTemplateId","palletLabelTemplate")
                val validation = original.getValue("shift").jsonObject.getValue("validationPrint").jsonObject
                val duplicate = validation["snapshot"]?.takeUnless { it == JsonNull }?.jsonObject
                require(local["duplicateTemplate"] == (duplicate?.get("spec") ?: JsonNull))
                require(local["duplicateTemplateDigest"] == (duplicate?.get("digest") ?: JsonNull))
                require((shift["validationPrintSnapshot"] ?: JsonNull) == (validation["snapshot"] ?: JsonNull))
                require((shift["validationPrintTemplateId"] ?: JsonNull) == (duplicate?.get("id") ?: JsonNull))
                val sscc = original["sscc"]?.takeUnless { it == JsonNull }?.jsonObject
                require(local["ssccIssuerPrefix"] == (sscc?.get("issuerPrefix") ?: JsonNull))
            }
            TaskKind.PICKUP -> error("Handheld pickup is unsupported")
        }
        return GrantTaskBindingEntity(owner,kind.wire,id,digest,canonical,grantDigest(local.toString()))
    }
}
