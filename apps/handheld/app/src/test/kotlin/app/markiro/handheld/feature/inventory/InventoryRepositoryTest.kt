package app.markiro.handheld.feature.inventory

import app.markiro.handheld.core.storage.initializeRecoveryForTest
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.inventory.InventoryBundleMirror
import app.markiro.handheld.core.network.InventoryTaskDto
import app.markiro.handheld.core.network.NetworkModule
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.InventoryFixtures
import app.markiro.handheld.core.storage.InventoryOutboxEntity
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.async
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory

@RunWith(AndroidJUnit4::class)
class InventoryRepositoryTest {
    private lateinit var db: HandheldDatabase
    private lateinit var server: MockWebServer
    private lateinit var api: StationApi
    private val task = InventoryTaskDto("i1", "INV-0007", "Вода 0,5 л", "Вода", "check", "l3", "Линия 3", "2026-08-01", "2026-08-31")

    @Before
    fun setUp() = runTest {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java).allowMainThreadQueries().build()
        server = MockWebServer().also { it.start() }
        api = Retrofit.Builder().baseUrl(server.url("/")).client(OkHttpClient())
            .addConverterFactory(NetworkModule.json().asConverterFactory("application/json".toMediaType())).build().create(StationApi::class.java)
        db.deviceConfigDao().upsert(
            DeviceConfigEntity(
                deviceId = "dev-1", deviceName = "ТСД 1", tenantId = "t", organizationName = "ООО", lineId = "l1", lineName = "Линия 2",
                kind = "handheld", serverUrl = "http://x", pairedAt = 1L,
            ),
        )
        db.initializeRecoveryForTest()
    }

    @After
    fun tearDown() {
        server.shutdown()
        db.close()
    }

    private fun repo() = InventoryRepository(api, db, InventoryBundleMirror(db, api), NetworkModule.json()) { 5L }

    @Test
    fun joinSendsConfirmationForAnotherLineAndMapsServerCodes() = runTest {
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"code":"INVENTORY_DIFFERENT_LINE_CONFIRMATION_REQUIRED"}"""))
        assertEquals(JoinResult.ConfirmationRequired, repo().join(task, "op-1", confirmDifferentLine = false, barcode = null))
        server.takeRequest()
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"code":"INVENTORY_NOT_RUNNING"}"""))
        assertEquals(JoinResult.NotRunning, repo().join(task, "op-1", confirmDifferentLine = true, barcode = null))
        assertEquals("""{"operatorId":"op-1","confirmDifferentLine":true}""", server.takeRequest().body.readUtf8())
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"code":"INVENTORY_OPERATOR_UNAVAILABLE"}"""))
        assertEquals(JoinResult.OperatorUnavailable, repo().join(task, "op-1", true, null))
        server.shutdown()
        assertEquals(JoinResult.Unavailable, repo().join(task, "op-1", true, null))
    }

    @Test
    fun activateAndLeaveMoveTheActiveTaskPointer() = runTest {
        db.inventoryTaskDao().upsert(InventoryFixtures.task("i1"))
        repo().activate("i1")
        assertEquals("i1", db.deviceConfigDao().get()?.activeInventoryId)
        db.inventoryOutboxDao().insert(InventoryOutboxEntity(inventoryId = "i1", snapshotId = "snap", eventId = "e1", deviceSequence = 1, payloadJson = "{}", createdAt = "t"))
        assertEquals(LeaveResult.Pending(1), repo().leave("i1"))
        db.inventoryOutboxDao().deleteIds(db.inventoryOutboxDao().head("i1", 1).map { it.id })
        server.enqueue(MockResponse().setBody("""{"outcome":"left"}"""))
        assertEquals(LeaveResult.Left, repo().leave("i1"))
        assertEquals("""{"pendingEventCount":0,"openBoxCount":0}""", server.takeRequest().body.readUtf8())
        assertNull(db.deviceConfigDao().get()?.activeInventoryId)
        assertEquals(5L, db.inventoryTaskDao().get("i1")?.leftAt)
        server.shutdown()
        assertEquals(LeaveResult.Left, repo().leave("i1"))
    }

    @Test
    fun interruptedNegotiatedLeaveKeepsOneChargeAndOriginalIntentThroughRetry() = runTest {
        db.inventoryTaskDao().upsert(InventoryFixtures.task("i1"))
        repo().activate("i1")
        db.grants.beginRefresh()
        db.grantDao().state(checkNotNull(db.grantDao().state()).copy(epoch = 3))
        server.enqueue(MockResponse().setResponseCode(503))
        assertEquals(LeaveResult.Failed, repo().leave("i1"))
        val first = server.takeRequest()
        assertEquals("/station/grants/v1/evidence/inventories/i1/leave", first.path)
        val original = first.body.readUtf8()
        assertEquals(1, db.grantDao().evidence().size)
        val evidence = db.grantDao().evidence().single()
        assertTrue(evidence.costs.contains("inventory.close.v1:events"))
        val recorder = app.markiro.handheld.core.inventory.InventoryRecorder(db)
        assertEquals("leave_pending", (recorder.record("i1", "raw", "op-1") as app.markiro.handheld.core.inventory.RecordOutcome.Recorded).invalidReason)
        assertEquals("i1", db.deviceConfigDao().get()?.activeInventoryId)
        val batch = kotlinx.serialization.json.Json.parseToJsonElement(original).let { it as kotlinx.serialization.json.JsonObject }.getValue("batchId").toString()
        server.enqueue(MockResponse().setBody("""{"protocol":"offline-grants-v1","batchId":$batch,"outcome":"duplicate","reason":"missing_grant","receiptId":"22222222-2222-4222-8222-222222222222","reconciliation":{"status":"applied","statusCode":201,"result":{"outcome":"left"}}}"""))
        assertEquals(LeaveResult.Left, repo().leave("i1"))
        assertEquals(original, server.takeRequest().body.readUtf8())
        assertEquals(1, db.grantDao().evidence().size)
        assertNull(db.deviceConfigDao().get()?.activeInventoryId)
        assertEquals(LeaveResult.Left, repo().leave("i1"))
        assertEquals(2, server.requestCount)
    }

    @Test
    fun quarantineKeepsCloseIntentAndBlocksOnlyNewScansForThatTask() = runTest {
        db.inventoryTaskDao().upsert(InventoryFixtures.task("i1"))
        db.inventoryTaskDao().upsert(InventoryFixtures.task("i2"))
        repo().activate("i1")
        db.grants.beginRefresh()
        db.grantDao().state(checkNotNull(db.grantDao().state()).copy(epoch = 3))
        server.enqueue(MockResponse().setResponseCode(503))
        assertEquals(LeaveResult.Failed, repo().leave("i1"))
        val original = server.takeRequest().body.readUtf8()
        val envelope = kotlinx.serialization.json.Json.parseToJsonElement(original) as kotlinx.serialization.json.JsonObject
        val batch = envelope.getValue("batchId")
        server.enqueue(MockResponse().setBody("""{"protocol":"offline-grants-v1","batchId":$batch,"outcome":"quarantined","reason":"late_no_proof","receiptId":"22222222-2222-4222-8222-222222222222","reconciliation":{"status":"not_applied","statusCode":null,"result":null}}"""))
        assertEquals(LeaveResult.Quarantined, repo().leave("i1"))
        assertEquals(original, server.takeRequest().body.readUtf8())
        assertNull(db.inventoryTaskDao().get("i1")?.leftAt)
        assertEquals(1, db.grantDao().evidence().size)
        assertTrue(app.markiro.handheld.core.inventory.InventoryLeaveJournal(db).pending("i1"))
        assertTrue(!app.markiro.handheld.core.inventory.InventoryLeaveJournal(db).pending("i2"))
        assertTrue(runCatching { repo().activate("i1") }.isFailure)
        repo().activate("i2")
        assertEquals("i2", db.deviceConfigDao().get()?.activeInventoryId)
    }

    @Test
    fun strictDenialRollsBackIntentAndQueuePreflightRunsInsideOwnerTransaction() = runTest {
        db.inventoryTaskDao().upsert(InventoryFixtures.task("i1"))
        repo().activate("i1")
        db.grants.beginRefresh()
        db.grantDao().state(checkNotNull(db.grantDao().state()).copy(epoch = 3, mode = "strict"))
        assertTrue(runCatching { repo().leave("i1") }.exceptionOrNull() is app.markiro.handheld.core.grants.GrantDenied)
        assertTrue(!app.markiro.handheld.core.inventory.InventoryLeaveJournal(db).pending("i1"))
        assertNull(db.inventoryTaskDao().get("i1")?.leftAt)
        assertEquals(0, server.requestCount)
        db.inventoryOutboxDao().insert(InventoryOutboxEntity(inventoryId = "i1", snapshotId = "snap", eventId = "e1", deviceSequence = 1, payloadJson = "{}", createdAt = "t"))
        assertEquals(LeaveResult.Pending(1), repo().leave("i1"))
        assertEquals(0, server.requestCount)
    }

    @Test
    fun scanRacingAnInFlightLeaveCannotAddWorkAfterTheAtomicCloseIntent() = runTest {
        db.inventoryTaskDao().upsert(InventoryFixtures.task("i1"))
        repo().activate("i1")
        server.enqueue(MockResponse().setHeadersDelay(1, java.util.concurrent.TimeUnit.SECONDS).setResponseCode(503))
        val leaving = async(kotlinx.coroutines.Dispatchers.Default) { repo().leave("i1") }
        assertTrue(server.takeRequest(2, java.util.concurrent.TimeUnit.SECONDS) != null)
        val scanned = app.markiro.handheld.core.inventory.InventoryRecorder(db).record("i1", "raw", "op-1") as app.markiro.handheld.core.inventory.RecordOutcome.Recorded
        assertEquals("leave_pending", scanned.invalidReason)
        assertNull(scanned.eventId)
        assertEquals(0, db.inventoryOutboxDao().count("i1"))
        assertEquals(LeaveResult.Failed, leaving.await())
        assertEquals(1, db.grantDao().evidence().size)
    }

    @Test
    fun listAndResolvePassThrough() = runTest {
        server.enqueue(MockResponse().setBody("""{"items":[]}"""))
        assertTrue(repo().listTasks("all").isEmpty())
        assertEquals("/station/inventory-tasks?scope=all", server.takeRequest().path)
        server.enqueue(MockResponse().setResponseCode(404).setBody("{}"))
        assertNull(repo().resolveBarcode("markiro:inventory:v1:nope"))
    }
}
