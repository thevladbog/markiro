package app.markiro.handheld.core.backend

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.box.SsccPool
import app.markiro.handheld.core.host.HostBlockSupplier
import app.markiro.handheld.core.host.HostCalls
import app.markiro.handheld.core.network.CredentialDto
import app.markiro.handheld.core.network.DeviceDto
import app.markiro.handheld.core.network.PairResponse
import app.markiro.handheld.core.network.ShiftEntryRequest
import app.markiro.handheld.core.network.host.HostApi
import app.markiro.handheld.core.network.host.HostResult
import app.markiro.handheld.core.network.host.HostTransport
import app.markiro.handheld.core.network.host.TransportFailure
import app.markiro.handheld.core.pallets.SsccBlockApplier
import app.markiro.handheld.core.storage.DeviceRecovery
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.HostPairing
import app.markiro.handheld.core.storage.InMemoryCredentialStore
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.feature.shift.ShiftEntityFixtures
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import retrofit2.HttpException
import java.io.IOException

@RunWith(AndroidJUnit4::class)
class HostBackendShiftsTest {
    private lateinit var db: HandheldDatabase

    @Before
    fun open() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        // Paired the way the app pairs (a synthetic config with a pin has no recovery row that owns it).
        kotlinx.coroutines.runBlocking {
            val recovery = DeviceRecovery(db, InMemoryCredentialStore()).also { it.initialize() }
            val origin = "https://192.168.1.10:45710"
            recovery.restore(
                PairResponse(DeviceDto("d1", "ТСД", "handheld", "h1", "", null), CredentialDto("k1", origin), emptyList()),
                origin,
                HostPairing("ab".repeat(32), "h1", listOf("192.168.1.10")),
            )
            db.deviceConfigDao().get()!!.let { db.deviceConfigDao().upsert(it.copy(lineName = "Линия 2")) }
        }
    }

    @After
    fun close() = db.close()

    private fun fixture(name: String) = checkNotNull(javaClass.classLoader?.getResource(name)) { name }.readText()

    /** Answers by path; keeps what was posted. */
    private class Routes(val answers: MutableMap<String, ArrayDeque<HostResult>>) : HostTransport {
        val posts = mutableListOf<Pair<String, String>>()
        override suspend fun get(path: String) = answers.getValue(path).removeFirst()
        override suspend fun post(path: String, body: String): HostResult {
            posts += path to body
            val queue = answers[path]?.takeIf { it.isNotEmpty() } ?: error("nothing scripted for POST $path")
            return queue.removeFirst()
        }
    }

    private fun ok(body: String, code: Int = 200) = HostResult.Ok(code, body, null)
    private fun refusal(code: Int, kind: String, details: String) =
        HostResult.Ok(code, """{"error":{"code":"$kind","message":"m","details":$details}}""", null)

    private val id = "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b"
    private val shiftPath = "/v1/device/shifts/$id/enter"
    private val block0 = """{"id":"b1000000-0000-4000-8000-000000000001","issuerPrefix":"460068200","extension":0,"fromSerial":1500,"toSerial":3499}"""
    private val block1 = """{"id":"b1000000-0000-4000-8000-000000000002","issuerPrefix":"460068200","extension":1,"fromSerial":40,"toSerial":239}"""

    private fun backend(routes: Routes, revoked: () -> Unit = {}): HostBackend {
        val api = HostApi(routes)
        val pool = SsccPool(db)
        val supplier = HostBlockSupplier(db, MetaStore(db), api, pool, SsccBlockApplier(pool), requestId = { "req-${routes.posts.size}" })
        return HostBackend(
            api = { api }, config = db.deviceConfigDao(), db = db, supplier = supplier,
            calls = HostCalls { revoked() }, reference = null, operators = db.operatorDao(),
        )
    }

    @Test
    fun theListIsTheHostsShiftsInTheShapeTheLoadersRead() = runTest {
        val routes = Routes(mutableMapOf("/v1/device/shifts" to ArrayDeque(listOf(ok(fixture("device-shifts.json"))))))
        val items = backend(routes).shifts().items
        assertEquals(listOf("active", "planned"), items.map { it.status }.take(2))
        val first = items.first()
        assertEquals("OCT26-004", first.number)
        assertEquals("Молоко 3,2% 0,9 л", first.productName)
        assertEquals("Линия 2", first.lineName)
        assertEquals(false, first.palletsEnabled)
        assertEquals("none", first.validationPrint.mode)
        assertNull(first.palletBoxCapacity)
    }

    @Test
    fun anEntryGivesTheBundleWithTheSnapshotsTemplatesAndBlocksOfBothExtensions() = runTest {
        val routes = Routes(
            mutableMapOf(
                shiftPath to ArrayDeque(listOf(ok(fixture("device-shift-entered-pallets.json")))),
                "/v1/device/sscc/blocks" to ArrayDeque(listOf(ok(block0), ok(block1))),
            ),
        )
        val backend = backend(routes)
        val shift = backend.enter(id, ShiftEntryRequest("list"))
        assertEquals("active", shift.status)
        assertEquals(40, shift.palletBoxCapacity)
        val bundle = backend.bundle(id)
        assertEquals("04600682000013", bundle.product.gtin14)
        assertEquals("Молоко 3,2%", bundle.product.printName)
        assertEquals(10, bundle.product.shelfLifeDays)
        assertEquals(58.0, bundle.boxLabelTemplate!!.spec.jsonObject.getValue("widthMm").jsonPrimitive.content.toDouble(), 0.0)
        assertNotNull(bundle.palletLabelTemplate)
        assertEquals(Triple("460068200", 0, 1500L), bundle.sscc!!.let { Triple(it.issuerPrefix, it.extensionDigit, it.fromSerial) })
        assertEquals("b1000000-0000-4000-8000-000000000001", bundle.sscc!!.blockId)
        assertEquals(Triple("460068200", 1, 40L), bundle.palletSscc!!.let { Triple(it.issuerPrefix, it.extensionDigit, it.fromSerial) })
        assertNull(bundle.ssccIssuerProblem)
        // One entry and two block requests, and the entry names the capability.
        assertEquals(1, routes.posts.count { it.first == shiftPath })
        assertTrue(routes.posts.first { it.first == shiftPath }.second.contains("handheld-host-v1"))
        assertEquals(2, routes.posts.count { it.first == "/v1/device/sscc/blocks" })
    }

    @Test
    fun theHostsRefusalsReachTheLoadersAsTheCodesTheyAlreadyRead() = runTest {
        fun entering(answer: HostResult) = backend(Routes(mutableMapOf(shiftPath to ArrayDeque(listOf(answer)))))
        suspend fun refused(answer: HostResult): Pair<Int, String> {
            val error = runCatching { entering(answer).enter(id, ShiftEntryRequest("list")) }.exceptionOrNull()
            val http = error as HttpException
            return http.code() to http.response()?.errorBody()?.string().orEmpty()
        }
        assertEquals(409 to """{"code":"STATION_UPDATE_REQUIRED"}""", refused(refusal(409, "conflict", """{"constraint":"station_update"}""")))
        assertEquals(409 to "{}", refused(refusal(409, "conflict", """{"constraint":"shift_status","status":"closed"}""")))
        assertEquals(409 to """{"code":"shift_busy"}""", refused(refusal(409, "conflict", """{"constraint":"shift_busy"}""")))
        assertEquals(409 to """{"code":"shift_line"}""", refused(refusal(409, "conflict", """{"constraint":"shift_line"}""")))
        assertEquals(409 to """{"code":"license_restricted"}""", refused(refusal(409, "conflict", """{"constraint":"license_restricted"}""")))
    }

    @Test
    fun aHostThatDoesNotAnswerIsAnIoErrorWhichTheLoadersTreatAsOffline() = runTest {
        for (failure in TransportFailure.entries) {
            val backend = backend(Routes(mutableMapOf(shiftPath to ArrayDeque(listOf(HostResult.Failed(failure))))))
            assertThrows(IOException::class.java) { kotlinx.coroutines.runBlocking { backend.enter(id, ShiftEntryRequest("list")) } }
        }
    }

    @Test
    fun aRejectedKeyRevokesTheDeviceOnceAndIsAnIoError() = runTest {
        var revoked = 0
        val backend = backend(
            Routes(mutableMapOf("/v1/device/shifts" to ArrayDeque(listOf(refusal(401, "unauthorized", """{"credential":"device"}"""))))),
            revoked = { revoked++ },
        )
        assertThrows(IOException::class.java) { kotlinx.coroutines.runBlocking { backend.shifts() } }
        assertEquals(1, revoked)
    }

    @Test
    fun theTopUpAsksForABlockOfTheShiftsPrefixAndReturnsWhatThePoolHolds() = runTest {
        val routes = Routes(mutableMapOf("/v1/device/sscc/blocks" to ArrayDeque(listOf(ok(block0)))))
        db.shiftDao().upsert(ShiftEntityFixtures.bundled("s1").copy(ssccIssuerPrefix = "460068200"))
        val top = backend(routes).topUpBoxSscc("s1")
        assertEquals(listOf(1500L), top.blocks.map { it.fromSerial })
        assertEquals(emptyList<Long>(), top.revokedFrom)
        assertNull(top.issuerProblem)
    }
}
