package app.markiro.handheld.feature.shift

import androidx.lifecycle.viewModelScope
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.MainDispatcherRule
import app.markiro.handheld.core.auth.OperatorRecord
import app.markiro.handheld.core.backend.HostBackend
import app.markiro.handheld.core.box.SsccPool
import app.markiro.handheld.core.host.HostBlockSupplier
import app.markiro.handheld.core.host.HostCalls
import app.markiro.handheld.core.host.HostRevocation
import app.markiro.handheld.core.network.CredentialDto
import app.markiro.handheld.core.network.DeviceDto
import app.markiro.handheld.core.network.LineDto
import app.markiro.handheld.core.network.PairResponse
import app.markiro.handheld.core.network.RevocationBus
import app.markiro.handheld.core.network.host.HostApi
import app.markiro.handheld.core.network.host.HostResult
import app.markiro.handheld.core.network.host.HostTransport
import app.markiro.handheld.core.network.host.TransportFailure
import app.markiro.handheld.core.pallets.SsccBlockApplier
import app.markiro.handheld.core.scan.ScanRouterAdapter
import app.markiro.handheld.core.storage.DeviceRecovery
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.HostPairing
import app.markiro.handheld.core.storage.InMemoryCredentialStore
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.feature.signin.SessionHolder
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class CreateShiftViewModelTest {
    @get:Rule val main = MainDispatcherRule()
    private lateinit var db: HandheldDatabase

    @After
    fun close() {
        try { main.cancelAndJoinModels() }
        finally { if (::db.isInitialized) db.close() }
    }

    @Test
    fun lostCreateAnswerSurvivesRecreationAndFailedEntryNeverRepeatsCreate() = runTest {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        val recovery = DeviceRecovery(db, InMemoryCredentialStore()).also { it.initialize() }
        val origin = "https://192.168.1.10:45710"
        recovery.restore(
            PairResponse(DeviceDto("d1", "ТСД", "handheld", "h1", "", LineDto("line", "Mobile")), CredentialDto("k1", origin), emptyList()),
            origin, HostPairing("ab".repeat(32), "h1", listOf("192.168.1.10")),
        )
        val calls = mutableListOf<Pair<String, String>>()
        val api = HostApi(object : HostTransport {
            override suspend fun get(path: String) = when (path) {
                "/v1/device/shift-create-options?lotNumbers=1" -> ok("""{
                    "lineId":"line","lineName":"Mobile","timeZone":"Europe/Moscow",
                    "palletsAllowed":true,"creationAllowed":true,"useLotNumbers":true,"products":[{"id":"p","name":"Product",
                    "gtin14":"04600682000020","group":1,"boxCapacity":12,"palletBoxCapacity":30}],
                    "templates":[{"id":"b","name":"Box","purpose":"box","groups":null,"supportsLotNumber":true}]
                }""")
                "/v1/device/shifts" -> ok("""{"shifts":[]}""")
                else -> error(path)
            }
            override suspend fun post(path: String, body: String): HostResult {
                calls += path to body
                return when (path) {
                    "/v1/device/shifts?lotNumbers=1" -> if (calls.size == 1) HostResult.Failed(TransportFailure.TIMEOUT) else ok("""{
                        "id":"s1","number":"NOV26-014/M","status":"planned","mode":"validation","lineId":"line",
                        "productId":"p","productName":"Product","productGtin14":"04600682000020",
                        "productionDate":"2026-11-11","boxCapacity":12
                    }""")
                    "/v1/device/shifts/s1/enter" -> HostResult.Failed(TransportFailure.TIMEOUT)
                    else -> error(path)
                }
            }
        })
        val meta = MetaStore(db)
        val pool = SsccPool(db)
        val supplier = HostBlockSupplier(db, meta, api, pool, SsccBlockApplier(pool))
        val backend = HostBackend({ api }, db.deviceConfigDao(), db, supplier, HostCalls { }, null, db.operatorDao())
        val repository = ShiftRepository(backend, db, Json, pool)
        val operator = SessionHolder().also { it.signIn(OperatorRecord("op", "Operator", "op", "operator", "", null, true)) }
        fun model() = main.track(CreateShiftViewModel(
            db, meta, api, HostRevocation(recovery, RevocationBus()), repository, operator, ScanRouterAdapter(emptyFlow()),
        ))

        val first = model()
        val options = checkNotNull(first.state.first { !it.busy }.options)
        first.select(options.products.single())
        first.edit {
            it.copy(
                mode = CreateShiftMode.VALIDATION, productionDate = "2026-11-11", plannedDate = "2026-11-12",
                lotNumber = "  0042Бк07AЁ  ",
            )
        }
        first.submit()
        assertEquals(CreateShiftIssue.OFFLINE, first.state.first { !it.busy }.issue)
        val frozen = Json.parseToJsonElement(calls.single().second).jsonObject
        assertNotNull(frozen["requestId"])
        assertEquals("line", frozen["expectedLineId"]?.jsonPrimitive?.content)
        assertEquals("2026-11-12", frozen["plannedDate"]?.jsonPrimitive?.content)
        assertNull(frozen["plannedQty"])
        assertEquals("0042Бк07AЁ", frozen["lotNumber"]?.jsonPrimitive?.content)
        first.viewModelScope.cancel()

        val second = model()
        assertEquals(true, second.state.first { !it.busy }.pending)
        second.submit()
        assertEquals(CreatedShiftLink("s1", "NOV26-014/M"), second.state.first { !it.busy }.created)
        assertEquals(calls[0], calls[1])
        assertEquals("/v1/device/shifts/s1/enter", calls[2].first)
        second.viewModelScope.cancel()

        val third = model()
        assertEquals("NOV26-014/M", third.state.first { !it.busy }.created?.number)
        third.submit()
        assertEquals(CreateShiftIssue.ENTER, third.state.first { !it.busy }.issue)
        assertEquals(listOf("/v1/device/shifts?lotNumbers=1", "/v1/device/shifts?lotNumbers=1", "/v1/device/shifts/s1/enter", "/v1/device/shifts/s1/enter"), calls.map { it.first })
    }

    private fun ok(body: String) = HostResult.Ok(200, body, null)
}
