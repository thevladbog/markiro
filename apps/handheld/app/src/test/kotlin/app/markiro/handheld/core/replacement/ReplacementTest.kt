package app.markiro.handheld.core.replacement

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.storage.*
import app.markiro.handheld.core.grants.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ReplacementTest {
    private fun database() = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java).allowMainThreadQueries().build().also { it.initializeRecoveryForTest() }
    private val intent = Json.parseToJsonElement("""{"version":1,"state":"active","intent":{"intentId":"11111111-1111-4111-8111-111111111111","preparationId":"22222222-2222-4222-8222-222222222222","credentialEpoch":7,"preparationRevision":2,"requestedAt":"2026-09-16T00:00:00Z","expiresAt":"2026-09-17T00:00:00Z"}}""").jsonObject
    private fun closure(state: String = "cancelled") = buildJsonObject {
        put("version",1); put("state",state)
        intent.getValue("intent").jsonObject.filterKeys { it !in setOf("requestedAt","expiresAt","preparationRevision") }.forEach { (k,v) -> put(k,v) }
        put("preparationRevision",3); put("closedAt","2026-09-16T01:00:00Z")
    }
    @Test fun cancellationNeedsExactDurableAckAndNullCannotRelease() = runTest {
        val db=database()
        try {
            val local=ReplacementReadiness(db); val token=db.recovery.token()
            local.apply(token,intent)
            assertTrue(local.blocked())
            local.apply(token,null); local.apply(token,buildJsonObject { put("version",1); put("state","none") })
            assertTrue(local.blocked())
            assertTrue(runCatching { db.grants.start(TaskKind.SHIFT,"new","entry") }.isFailure)
            local.apply(token,closure())
            val body=checkNotNull(local.pendingClosure(token))
            assertTrue(local.blocked())
            val response=JsonObject(body + ("acknowledgedAt" to JsonPrimitive("2026-09-16T01:00:01Z")))
            assertTrue(runCatching { local.acknowledgeClosure(token,body,JsonObject(response + ("requestId" to JsonPrimitive("wrong")))) }.isFailure)
            db.openHelper.writableDatabase.execSQL("CREATE TRIGGER fail_ack BEFORE INSERT ON replacement_drain BEGIN SELECT RAISE(ABORT,'failure'); END")
            assertTrue(runCatching { local.acknowledgeClosure(token,body,response) }.isFailure)
            assertTrue(local.blocked())
            db.openHelper.writableDatabase.execSQL("DROP TRIGGER fail_ack")
            local.acknowledgeClosure(token,body,response)
            assertFalse(local.blocked())
            local.apply(token,intent)
            assertFalse(local.blocked())
            db.grants.start(TaskKind.SHIFT,"new","entry-after-ack")
        } finally { db.close() }
    }
    @Test fun closedNeverReopensAndChangedGenerationCannotAcknowledge() = runTest {
        val db=database()
        try {
            val local=ReplacementReadiness(db); val token=db.recovery.token()
            local.apply(token,intent); local.apply(token,closure("closed"))
            val body=checkNotNull(local.pendingClosure(token))
            local.acknowledgeClosure(token,body,JsonObject(body+("acknowledgedAt" to JsonPrimitive("2026-09-16T02:00:00Z"))))
            assertTrue(local.blocked())
            db.recovery.reject(token); db.reconnectSameDeviceForTest()
            assertTrue(runCatching { local.pendingClosure(db.recovery.token()) }.isFailure)
            assertTrue(local.blocked())
        } finally { db.close() }
    }
    @Test fun reportRetryIsIdenticalAndCountsIncludeAllChannels() = runTest {
        val db=database()
        try {
            val local=ReplacementReadiness(db); val token=db.recovery.token()
            local.apply(token,intent)
            db.outboxDao().insert(OutboxEntity(shiftId="s",raw="secret-scan",verdict="invalid",scannedAt="now",operatorId=null,codeHash=null,gtin14=null,serial=null))
            val first=local.prepareReport(token)
            assertEquals(1,first.getValue("pending").jsonObject.getValue("scans").jsonPrimitive.int)
            assertEquals(setOf("scans","inventories","shiftClosures","productLabels","boxes","exceptions"),first.getValue("pending").jsonObject.keys)
            assertFalse(first.toString().contains("secret-scan"))
            db.outboxDao().insert(OutboxEntity(shiftId="s",raw="second",verdict="invalid",scannedAt="now",operatorId=null,codeHash=null,gtin14=null,serial=null))
            assertEquals(first,local.prepareReport(token))
            local.acknowledgeReport(token,first,buildJsonObject { put("requestId",first.getValue("requestId")); put("intentId",first.getValue("intentId")); put("receivedAt","2026-09-16T02:00:00Z"); put("unsupportedChannels",JsonArray(emptyList())); put("eligibility",buildJsonObject { put("status","blocked"); put("reasons",JsonArray(listOf(JsonPrimitive("pending_scans")))) }) })
            val second=local.prepareReport(token)
            assertEquals(2,second.getValue("pending").jsonObject.getValue("scans").jsonPrimitive.int)
            assertTrue(second.getValue("storageRevision").jsonPrimitive.long > first.getValue("storageRevision").jsonPrimitive.long)
            assertNotEquals(first.getValue("requestId"),second.getValue("requestId"))
        } finally { db.close() }
    }
    @Test fun cancellationPropagates() = runTest {
        val error=CancellationException("cancelled")
        assertSame(error,runCatching { replacementIfAvailable { throw error } }.exceptionOrNull())
    }
    @Test fun measuresAllQueuesAndExcludesSettledHistory() = runTest {
        val db=database()
        fun insert(table: String, values: Map<String, Any?> = emptyMap()) {
            val row=android.content.ContentValues()
            db.openHelper.readableDatabase.query("PRAGMA table_info($table)").use { columns ->
                while (columns.moveToNext()) {
                    val name=columns.getString(1)
                    if (name in values) continue
                    if (columns.getInt(3) == 1) {
                        if (columns.getString(2) == "INTEGER") row.put(name,1L) else row.put(name,"fixture-$name")
                    }
                }
            }
            values.forEach { (key,value) -> when(value) { null -> row.putNull(key); is Long -> row.put(key,value); else -> row.put(key,value.toString()) } }
            db.openHelper.writableDatabase.insert(table,android.database.sqlite.SQLiteDatabase.CONFLICT_ABORT,row)
        }
        try {
            insert("outbox")
            insert("inventory_outbox")
            insert("shift_close_outbox",mapOf("state" to "pending"))
            insert("product_label_events")
            insert("product_label_jobs",mapOf("status" to "pending","attemptState" to "delivery_unknown"))
            insert("boxes",mapOf("printState" to "unknown","closedAt" to "now"))
            insert("pallets",mapOf("printState" to "printing","closedAt" to "now"))
            insert("box_exceptions")
            insert("pallet_exceptions")
            insert("writeoff_outbox",mapOf("state" to "pending"))
            insert("conflicts_mirror")
            insert("shift_mirror",mapOf("status" to "active","enteredAt" to 1L,"leftAt" to null))
            insert("inventory_tasks",mapOf("state" to "active","leftAt" to null))
            val local=ReplacementReadiness(db)
            var snapshot=local.snapshot()
            val pending=snapshot.getValue("pending").jsonObject
            assertEquals(1L,pending.getValue("scans").jsonPrimitive.long)
            assertEquals(1L,pending.getValue("inventories").jsonPrimitive.long)
            assertEquals(1L,pending.getValue("shiftClosures").jsonPrimitive.long)
            assertEquals(2L,pending.getValue("productLabels").jsonPrimitive.long)
            assertEquals(2L,pending.getValue("boxes").jsonPrimitive.long)
            assertEquals(3L,pending.getValue("exceptions").jsonPrimitive.long)
            assertEquals(1L,snapshot.getValue("conflicts").jsonPrimitive.long)
            assertEquals(3L,snapshot.getValue("unknownPrints").jsonPrimitive.long)
            assertEquals(2,snapshot.getValue("activeTasks").jsonArray.size)
            val sql=db.openHelper.writableDatabase
            sql.execSQL("UPDATE shift_close_outbox SET state='accepted'")
            sql.execSQL("UPDATE product_label_jobs SET status='completed'")
            sql.execSQL("UPDATE writeoff_outbox SET state='sent'")
            snapshot=local.snapshot()
            assertEquals(0L,snapshot.getValue("pending").jsonObject.getValue("shiftClosures").jsonPrimitive.long)
            assertEquals(2L,snapshot.getValue("pending").jsonObject.getValue("exceptions").jsonPrimitive.long)
            assertEquals(2L,snapshot.getValue("unknownPrints").jsonPrimitive.long)
        } finally { db.close() }
    }

    @Test fun reportAndIntentCannotOverwritePendingClosureAndNewIntentCapturesNewTasks() = runTest {
        val db=database()
        try {
            val local=ReplacementReadiness(db); val token=db.recovery.token()
            local.apply(token,intent); val report=local.prepareReport(token)
            local.apply(token,closure())
            val saved=db.replacementDao().get()
            assertTrue(runCatching { local.prepareReport(token) }.isFailure)
            val nextIntent=JsonObject(intent.getValue("intent").jsonObject + mapOf(
                "intentId" to JsonPrimitive("33333333-3333-4333-8333-333333333333"),
                "preparationId" to JsonPrimitive("44444444-4444-4444-8444-444444444444"),
                "requestedAt" to JsonPrimitive("2026-09-16T02:00:00Z")))
            val next=buildJsonObject { put("version",1); put("state","active"); put("intent",nextIntent) }
            local.apply(token,next)
            assertEquals(saved,db.replacementDao().get())
            val body=checkNotNull(local.pendingClosure(token))
            local.acknowledgeClosure(token,body,JsonObject(body+("acknowledgedAt" to JsonPrimitive("2026-09-16T01:00:01Z"))))
            db.shiftDao().upsert(app.markiro.handheld.feature.shift.ShiftEntityFixtures.bundled("55555555-5555-4555-8555-555555555555").copy(enteredAt=1, leftAt=null, status="active"))
            local.apply(token,next)
            assertTrue(local.blocked())
            local.requireAdmission("shift","55555555-5555-4555-8555-555555555555")
            assertTrue(runCatching { local.requireAdmission("shift","other") }.isFailure)
            assertNotEquals(report,local.prepareReport(token))
        } finally { db.close() }
    }

    @Test fun failedIntentWriteRetainsDeviceGrantAndIneffectiveAckNeverReleases() = runTest {
        val db=database()
        try {
            val local=ReplacementReadiness(db); val token=db.recovery.token()
            val owner=token.owner.grantOwnerKey()
            val grant=GrantTokenEntity("device",owner,token.generation,7,"device","","","test","retained-bytes")
            db.grantDao().token(grant)
            val sql=db.openHelper.writableDatabase
            sql.execSQL("CREATE TRIGGER fail_intent BEFORE INSERT ON replacement_drain BEGIN SELECT RAISE(ABORT,'failed'); END")
            assertTrue(runCatching { local.apply(token,intent) }.isFailure)
            assertEquals(grant,db.grantDao().token("device")); assertNull(db.replacementDao().get())
            sql.execSQL("DROP TRIGGER fail_intent")
            local.apply(token,intent); assertNull(db.grantDao().token("device"))
            local.apply(token,closure()); val body=checkNotNull(local.pendingClosure(token))
            sql.execSQL("CREATE TRIGGER ignore_ack BEFORE INSERT ON replacement_drain WHEN NEW.acknowledgedAt IS NOT NULL BEGIN SELECT RAISE(IGNORE); END")
            assertTrue(runCatching { local.acknowledgeClosure(token,body,JsonObject(body+("acknowledgedAt" to JsonPrimitive("2026-09-16T01:00:01Z")))) }.isFailure)
            assertTrue(local.blocked())
            assertEquals(body,local.pendingClosure(token))
        } finally { db.close() }
    }
    @Test fun retainedEvidenceAndPinnedBatchesBlockUntilFinalReceipt() = runTest {
        val db=database()
        try {
            val local=ReplacementReadiness(db)
            db.metaDao().put(MetaEntity("grant_transport:one","""{"negotiated":true}"""))
            db.metaDao().put(MetaEntity("inventory_pending_batch:one","retained bytes"))
            assertEquals(2L,local.snapshot().getValue("pending").jsonObject.getValue("exceptions").jsonPrimitive.long)
            db.metaDao().put(MetaEntity("grant_transport:one:receipt","""{"outcome":"quarantined","reconciliation":{"status":"not_applied"}}"""))
            assertEquals(2L,local.snapshot().getValue("pending").jsonObject.getValue("exceptions").jsonPrimitive.long)
            db.metaDao().put(MetaEntity("grant_transport:one:receipt","""{"outcome":"duplicate","reconciliation":{"status":"applied"}}"""))
            db.metaDao().remove("inventory_pending_batch:one")
            assertEquals(0L,local.snapshot().getValue("pending").jsonObject.getValue("exceptions").jsonPrimitive.long)
        } finally { db.close() }
    }

    @Test fun journalUsesDurableSequenceAndMissingSchemaIsUnsupported() = runTest {
        val db=database()
        try {
            val local=ReplacementReadiness(db); val token=db.recovery.token()
            local.apply(token,intent)
            db.outboxDao().insert(OutboxEntity(id=42,shiftId="s",raw="retained",verdict="invalid",scannedAt="now",operatorId=null,codeHash=null,gtin14=null,serial=null))
            val body=local.prepareReport(token)
            assertEquals(42L,body.getValue("journal").jsonObject.getValue("highestSequence").jsonPrimitive.long)
            db.openHelper.writableDatabase.execSQL("DROP TABLE conflicts_mirror")
            assertEquals("unsupported",local.snapshot().getValue("conflicts").jsonPrimitive.content)
        } finally { db.close() }
    }

    @Test fun newerAuthenticatedEpochCanDrainAStaleGrantCacheAndSettledPreviousGeneration() = runTest {
        val db=database()
        try {
            val local=ReplacementReadiness(db); val token=db.recovery.token()
            db.grants.beginRefresh()
            db.grantDao().state(checkNotNull(db.grantDao().state()).copy(epoch=6))
            local.apply(token,intent)
            assertTrue(local.blocked())
            local.apply(token,closure()); val body=checkNotNull(local.pendingClosure(token))
            local.acknowledgeClosure(token,body,JsonObject(body+("acknowledgedAt" to JsonPrimitive("2026-09-16T01:00:01Z"))))
            db.recovery.reject(token); db.reconnectSameDeviceForTest()
            val fresh=db.recovery.token()
            assertNull(local.pendingClosure(fresh))
            assertTrue(runCatching { local.acknowledgeClosure(fresh,body,JsonObject(body+("acknowledgedAt" to JsonPrimitive("2026-09-16T01:00:01Z")))) }.isFailure)
            val next=JsonObject(intent.getValue("intent").jsonObject+mapOf("intentId" to JsonPrimitive("33333333-3333-4333-8333-333333333333"),"preparationId" to JsonPrimitive("44444444-4444-4444-8444-444444444444"),"credentialEpoch" to JsonPrimitive(8),"requestedAt" to JsonPrimitive("2026-09-16T02:00:00Z")))
            local.apply(fresh,buildJsonObject { put("version",1); put("state","active"); put("intent",next) })
            assertTrue(local.blocked())
            assertEquals(fresh.generation,db.replacementDao().get()?.generation)
            assertEquals(8L,local.prepareReport(fresh).getValue("credentialEpoch").jsonPrimitive.long)
        } finally { db.close() }
    }

}
