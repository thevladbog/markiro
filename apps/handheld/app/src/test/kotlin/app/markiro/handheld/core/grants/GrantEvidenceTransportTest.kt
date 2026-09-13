package app.markiro.handheld.core.grants

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.storage.*
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class GrantEvidenceTransportTest {
    private suspend fun database(): HandheldDatabase {
        val db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java).allowMainThreadQueries().build()
        db.deviceConfigDao().upsert(syntheticDeviceConfig())
        DeviceRecovery(db, InMemoryCredentialStore().also { it.write("test-key") }).initialize()
        return db
    }
    @Test fun negotiatedObserveWithoutGrantWrapsButOldQueuedWorkRemainsLegacy() = runTest {
        val db = database()
        try {
            val transport = GrantEvidenceTransport(db)
            db.grants.complete(TaskKind.SHIFT, "shift", "old", GrantEventType.SHIFT_SCAN, units = 1)
            db.grants.beginRefresh()
            db.grantDao().state(checkNotNull(db.grantDao().state()).copy(epoch = 3, installedSequence = 1))
            db.grants.complete(TaskKind.SHIFT, "shift", "new", GrantEventType.SHIFT_SCAN, units = 1)
            assertFalse(transport.negotiated("old"))
            assertTrue(transport.negotiated("new"))
            val payload = """{"items":[{"raw":"010123\u001dABC"}],"batchId":"batch"}"""
            val prepared = transport.prepare("scans", "batch", "/station/scans", payload, mapOf("/items/0#shift.scan.v1" to "new"), true)
            assertEquals("/station/grants/v1/evidence/scans", prepared.path)
            val envelope = Json.parseToJsonElement(prepared.body).jsonObject
            assertEquals(Json.parseToJsonElement(payload), envelope["payload"])
            assertEquals(JsonArray(emptyList()), envelope["grants"])
            assertEquals(JsonObject(emptyMap()), envelope["eventGrants"])
            db.grantDao().state(checkNotNull(db.grantDao().state()).copy(epoch = 4))
            assertEquals(prepared, transport.prepare("scans", "batch", "/station/scans", payload, emptyMap(), false))
            assertEquals("/station/scans", transport.prepare("legacy", "old-batch", "/station/scans", payload, emptyMap(), false).path)
        } finally { db.close() }
    }
    @Test fun originalCompactIsPinnedAndReceiptsNeverTurnQuarantineIntoNativeSuccess() = runTest {
        val db = database()
        try {
            val owner = db.recovery.token().owner.grantOwnerKey()
            val id = "11111111-1111-4111-8111-111111111111"
            db.grantDao().evidence(GrantEvidenceEntity(owner,"event","shift","shift","snapshot","digest","{}",id,"original.compact.bytes","observe",null,1000,1,1))
            val transport = GrantEvidenceTransport(db)
            val request = transport.prepare("scans", "batch", "/station/scans", """{"items":[]}""", mapOf("/items/0#shift.scan.v1" to "event"), true)
            assertEquals("original.compact.bytes", Json.parseToJsonElement(request.body).jsonObject.getValue("grants").jsonArray.single().jsonPrimitive.content)
            val receipt = """{"protocol":"offline-grants-v1","batchId":"batch","outcome":"duplicate","reason":"budget_exceeded","receiptId":"22222222-2222-4222-8222-222222222222","reconciliation":{"status":"not_applied","statusCode":null,"result":null}}"""
            assertNull(transport.nativeResult(request, receipt))
            assertNotNull(db.metaDao().get(MetaStore.SYNC_LAST_DENIED))
            assertEquals("review", db.metaDao().get(GrantEvidenceTransport.diagnosticKey(owner)))
            assertEquals(receipt, transport.receipt(request))
            assertNull(transport.nativeResult(request, receipt.replace("budget_exceeded", "changed_reason")))
            assertEquals(receipt, transport.receipt(request))
            assertNull(transport.nativeResult(request, receipt.replace("\"batch\"", "\"other\"")))
        } finally { db.close() }
    }
    @Test fun pinnedEnvelopeAndNegotiationSurviveDatabaseCloseAndReopen() = runTest {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val name = "grant-evidence-${java.util.UUID.randomUUID()}"
        val credentials = InMemoryCredentialStore().also { it.write("test-key") }
        var db = Room.databaseBuilder(context, HandheldDatabase::class.java, name).allowMainThreadQueries().build()
        try {
            db.deviceConfigDao().upsert(syntheticDeviceConfig())
            DeviceRecovery(db, credentials).initialize()
            db.grants.beginRefresh()
            db.grantDao().state(checkNotNull(db.grantDao().state()).copy(epoch = 3))
            db.grants.complete(TaskKind.SHIFT, "shift", "event", GrantEventType.SHIFT_SCAN, units = 1)
            val original = GrantEvidenceTransport(db).prepare("scans", "batch", "/station/scans", """{"items":[]}""", mapOf("/items/0#shift.scan.v1" to "event"), true)
            db.close()
            db = Room.databaseBuilder(context, HandheldDatabase::class.java, name).allowMainThreadQueries().build()
            DeviceRecovery(db, credentials).initialize()
            assertTrue(GrantEvidenceTransport(db).negotiated("event"))
            assertEquals(original, GrantEvidenceTransport(db).prepare("scans", "batch", "/station/scans", """{"items":[]}""", emptyMap(), false))
        } finally { db.close(); context.deleteDatabase(name) }
    }

    @Test fun domainProducedDigestsMatchIncludingLoneSurrogatesAndNumericKeys() {
        val fixture = checkNotNull(javaClass.classLoader?.getResourceAsStream("grant-evidence-digests.json")).bufferedReader().use { it.readText() }
        for (row in Json.parseToJsonElement(fixture).jsonArray.map { it.jsonObject }) {
            assertEquals(row.getValue("digest").jsonPrimitive.content, grantDigest(grantEvidenceCanonical(row.getValue("payload"))))
        }
    }

    @Test fun canonicalPayloadUsesSortedKeysExactSeparatorsAndArrayOrder() {
        val a = Json.parseToJsonElement("""{"z":[2,1],"a":{"raw":"ABC\u001dDEF","n":0}}""")
        assertEquals("""{"a":{"n":0,"raw":"ABC\u001dDEF"},"z":[2,1]}""", grantEvidenceCanonical(a))
    }
}
