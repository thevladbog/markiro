package app.markiro.handheld.feature.inventory

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
        assertEquals(LeaveResult.Offline, repo().leave("i1"))
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
