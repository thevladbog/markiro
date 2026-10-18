package app.markiro.handheld.core.host

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.box.SsccPool
import app.markiro.handheld.core.network.CredentialDto
import app.markiro.handheld.core.network.DeviceDto
import app.markiro.handheld.core.network.PairResponse
import app.markiro.handheld.core.network.host.HostApi
import app.markiro.handheld.core.network.host.HostResult
import app.markiro.handheld.core.network.host.HostTransport
import app.markiro.handheld.core.pallets.SsccBlockApplier
import app.markiro.handheld.core.storage.DeviceRecovery
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.HostPairing
import app.markiro.handheld.core.storage.InMemoryCredentialStore
import app.markiro.handheld.core.storage.MetaStore
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class HostBootstrapImplTest {
    private lateinit var db: HandheldDatabase
    private val hostId = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f"
    private val lineId = "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61"

    @Before
    fun open() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java).allowMainThreadQueries().build()
        kotlinx.coroutines.runBlocking {
            val recovery = DeviceRecovery(db, InMemoryCredentialStore()).also { it.initialize() }
            val origin = "https://192.168.1.10:45710"
            recovery.restore(
                PairResponse(DeviceDto("d1", "ТСД", "handheld", hostId, "", null), CredentialDto("k1", origin), emptyList()),
                origin,
                HostPairing("ab".repeat(32), hostId, listOf("192.168.1.10")),
            )
        }
    }

    @After
    fun close() = db.close()

    private fun fixture(name: String) = checkNotNull(javaClass.classLoader?.getResource(name)) { name }.readText()

    private class Host(val answers: Map<String, HostResult>) : HostTransport {
        val asked = mutableListOf<String>()
        override suspend fun get(path: String) = (if (path == "/v1/hello") HostResult.Ok(200, """{"product":"markiro-host","protocol":6,"minProtocol":1,"hostId":"legacy"}""", null) else answers.getValue(path.substringBefore('?'))).also { asked += path }
        override suspend fun post(path: String, body: String) = answers.getValue(path).also { asked += path }
    }

    private fun bootstrap(host: Host): HostBootstrapImpl {
        val api = HostApi(host)
        val meta = MetaStore(db)
        val pool = SsccPool(db)
        val reference = HostReferenceSync(db, db.deviceConfigDao(), meta, api)
        return HostBootstrapImpl(db, db.deviceConfigDao(), meta, api, reference, HostBlockSupplier(db, meta, api, pool, SsccBlockApplier(pool)))
    }

    @Test
    fun theFirstSyncReadsTheFeedThePrefixTheLineAndTakesABlock() = runTest {
        val host = Host(
            mapOf(
                "/v1/changes" to HostResult.Ok(200, fixture("changes-response.json"), null),
                "/v1/device/org/print" to HostResult.Ok(200, fixture("org-print.json"), null),
                "/v1/device" to HostResult.Ok(200, """{"id":"d1","kind":"handheld","name":"ТСД","lineId":"$lineId"}""", null),
                "/v1/device/sscc/blocks" to HostResult.Ok(200, """{"id":"b1000000-0000-4000-8000-000000000001","issuerPrefix":"460068200","extension":0,"fromSerial":1500,"toSerial":3499}""", null),
            ),
        )
        bootstrap(host).initialSync().getOrThrow()
        val config = db.deviceConfigDao().get()!!
        assertEquals(lineId, config.lineId)
        assertEquals("Линия 2", config.lineName)
        assertEquals(42L, config.hostRev)
        assertEquals("460068200", MetaStore(db).get(MetaStore.PALLET_BOOTSTRAP_ISSUER_PREFIX))
        assertEquals(2000L, db.ssccPoolDao().remaining("460068200", 0))
    }

    @Test
    fun aStepThatFailsFailsThePairingsSync() = runTest {
        val host = Host(
            mapOf(
                "/v1/changes" to HostResult.Ok(200, fixture("changes-response.json"), null),
                "/v1/device/org/print" to HostResult.Failed(app.markiro.handheld.core.network.host.TransportFailure.TIMEOUT),
            ),
        )
        assertTrue(bootstrap(host).initialSync().isFailure)
    }
}
