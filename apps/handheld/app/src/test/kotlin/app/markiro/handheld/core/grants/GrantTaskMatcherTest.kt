package app.markiro.handheld.core.grants

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.storage.*
import app.markiro.handheld.feature.shift.ShiftEntityFixtures
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class GrantTaskMatcherTest {
    private suspend fun database(): HandheldDatabase {
        val db=Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(),HandheldDatabase::class.java).allowMainThreadQueries().build()
        db.deviceConfigDao().upsert(syntheticDeviceConfig()); DeviceRecovery(db,InMemoryCredentialStore().also { it.write("test-key") }).initialize()
        return db
    }
    @Test fun inventoryBindsOriginalCanonicalBytesAndEveryExecutedManifestFact() = runTest {
        val db=database()
        try {
            db.inventoryTaskDao().upsert(InventoryFixtures.task("i1"))
            val manifest=JsonObject(checkNotNull(GrantTaskMatcher.projection(db,TaskKind.INVENTORY,"i1")) + buildJsonObject {
                put("snapshotRevision",1); put("egaisCode",JsonNull); put("shelfLifeDays",JsonNull); put("boxLabelTemplate",JsonNull)
                put("limits",buildJsonObject { put("codePageSize",200); put("eventBatchSize",200); put("progressPageSize",200) })
            })
            db.grants.saveProvenance(TaskKind.INVENTORY,"i1",manifest.toString())
            val canonical=buildJsonObject { put("taskKind","inventory"); put("taskId","i1"); put("scope",buildJsonObject {
                put("manifest",manifest); listOf("snapshotId","combinedDigest","contentDigest").forEach { put(it,manifest.getValue(it)) }
            }) }.toString()
            val owner=db.recovery.token().owner.grantOwnerKey()
            val binding=GrantTaskMatcher.bind(db,owner,TaskKind.INVENTORY,"i1",grantDigest(canonical),canonical)
            assertEquals(GrantTaskMatcher.fingerprint(db,TaskKind.INVENTORY,"i1"),binding.executionFingerprint)
            assertTrue(runCatching { GrantTaskMatcher.bind(db,owner,TaskKind.INVENTORY,"i1",grantDigest(canonical),canonical+" ") }.isFailure)
            db.inventoryTaskDao().upsert(InventoryFixtures.task("i1").copy(productionDateTo="2026-09-01"))
            assertTrue(runCatching { GrantTaskMatcher.bind(db,owner,TaskKind.INVENTORY,"i1",grantDigest(canonical),canonical) }.isFailure)
            assertNotEquals(binding.executionFingerprint,GrantTaskMatcher.fingerprint(db,TaskKind.INVENTORY,"i1"))
        } finally { db.close() }
    }

    @Test fun legacyTaskWithoutAuthenticatedProvenanceCannotAcquireBinding() = runTest {
        val db=database()
        try {
            db.inventoryTaskDao().upsert(InventoryFixtures.task("i1"))
            val canonical="""{"taskKind":"inventory","taskId":"i1","scope":{}}"""
            assertTrue(runCatching { GrantTaskMatcher.bind(db,db.recovery.token().owner.grantOwnerKey(),TaskKind.INVENTORY,"i1",grantDigest(canonical),canonical) }.isFailure)
        } finally { db.close() }
    }

    @Test fun signedCounterpartyTextMustMatchNewlyRenderedLabelContext() = runTest {
        val db=database()
        try {
            val local=ShiftEntityFixtures.bundled("s1").copy(counterpartyName="Factory A")
            db.shiftDao().upsert(local)
            val projected=checkNotNull(GrantTaskMatcher.projection(db,TaskKind.SHIFT,"s1"))
            val shift=buildJsonObject {
                listOf("id","mode","productId","lineId","plannedDate","productionDate","boxCapacity","palletsEnabled","palletBoxCapacity","validationPrintMode","allowPreviouslyAcceptedCodes","validationPrintVerification","validationPrintPolicyRevision","stationClosePolicy","stationCloseOwnerDeviceId","counterpartyName").forEach { put(it,projected.getValue(it)) }
                listOf("counterpartyId","ssccIssuerCounterpartyId","boxLabelTemplateId","palletLabelTemplateId","labelTemplateId","validationPrintSnapshot","validationPrintTemplateId").forEach { put(it,JsonNull) }
                put("numberMonthKey","SEP26"); put("numberSeq",1); put("createdFrom","admin")
            }
            val bundleShift=buildJsonObject {
                listOf("counterpartyId","ssccIssuerCounterpartyId","boxLabelTemplateId","palletLabelTemplateId","createdFrom").forEach { put(it,shift.getValue(it)) }
                listOf("lineName","counterpartyName","plannedQty").forEach { put(it,projected.getValue(it)) }
                put("validationPrint",buildJsonObject { put("mode","none"); put("snapshot",JsonNull) })
            }
            db.grants.saveProvenance(TaskKind.SHIFT,"s1",buildJsonObject { put("shift",bundleShift) }.toString())
            val product=buildJsonObject { put("chzProductGroupCode",JsonNull); put("id",local.productId); put("name",local.productName); put("printName",JsonNull); put("gtin14",local.productGtin14); put("shelfLifeDays",JsonNull); put("egaisCode",JsonNull) }
            fun canonical(signed: JsonObject)=buildJsonObject { put("taskKind","shift"); put("taskId","s1"); put("scope",buildJsonObject { put("shift",signed); put("product",product); put("templates",JsonArray(emptyList())) }) }.toString()
            val valid=canonical(shift); val owner=db.recovery.token().owner.grantOwnerKey()
            GrantTaskMatcher.bind(db,owner,TaskKind.SHIFT,"s1",grantDigest(valid),valid)
            val enabledLocal = local.copy(allowPreviouslyAcceptedCodes=true)
            db.shiftDao().upsert(enabledLocal)
            assertTrue(runCatching { GrantTaskMatcher.bind(db,owner,TaskKind.SHIFT,"s1",grantDigest(valid),valid) }.isFailure)
            val enabledShift = JsonObject(shift+("allowPreviouslyAcceptedCodes" to JsonPrimitive(true)))
            val enabledCanonical = canonical(enabledShift)
            GrantTaskMatcher.bind(db,owner,TaskKind.SHIFT,"s1",grantDigest(enabledCanonical),enabledCanonical)
            db.shiftDao().upsert(local)
            db.shiftDao().upsert(local.copy(productPrintName="stale fallback"))
            assertTrue(runCatching { GrantTaskMatcher.bind(db,owner,TaskKind.SHIFT,"s1",grantDigest(valid),valid) }.isFailure)
            db.shiftDao().upsert(local)
            val changed=canonical(JsonObject(shift+("counterpartyName" to JsonPrimitive("Factory B"))))
            assertTrue(runCatching { GrantTaskMatcher.bind(db,owner,TaskKind.SHIFT,"s1",grantDigest(changed),changed) }.isFailure)
        } finally { db.close() }
    }
}
