package app.markiro.handheld.core.host

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.auth.OperatorAuth
import app.markiro.handheld.core.network.CredentialDto
import app.markiro.handheld.core.network.DeviceDto
import app.markiro.handheld.core.network.PairResponse
import app.markiro.handheld.core.network.host.HostApi
import app.markiro.handheld.core.network.host.HostResult
import app.markiro.handheld.core.network.host.HostTransport
import app.markiro.handheld.core.storage.DeviceRecovery
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.HostPairing
import app.markiro.handheld.core.storage.InMemoryCredentialStore
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.storage.RosterStore
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The whole chain after a pairing with the REAL verifier: the host's `GET /v1/changes` answer (the shared fixture, the shape the host
 * writes) into Room, the roster the sign-in reads, and a PIN and a badge checked with [app.markiro.handheld.core.auth.PhcVerifier].
 * Nothing here is stubbed except the transport: it proves the hashing, the field names and the roster mapping are NOT the reason a
 * paired handheld finds nobody (the reason is when the roster is read, see `SignInViewModelTest`).
 */
@RunWith(AndroidJUnit4::class)
class HostSignInChainTest {
    private lateinit var db: HandheldDatabase
    private val hostId = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f"

    private class Feed(val pages: ArrayDeque<String>) : HostTransport {
        override suspend fun get(path: String): HostResult = HostResult.Ok(200, pages.removeFirst(), null)
        override suspend fun post(path: String, body: String): HostResult = error("read only")
    }

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

    private fun auth() = OperatorAuth(RosterStore(db.operatorDao(), db.recovery, db.operatorBadgeDao()))

    @Test
    fun theHostsPinAndBadgeSignAHandheldInAfterTheFirstFeedRead() = runTest {
        val feed = Feed(ArrayDeque(listOf(fixture("changes-people.json"))))
        HostReferenceSync(db, db.deviceConfigDao(), MetaStore(db), HostApi(feed)).sync().getOrThrow()
        val auth = auth()
        // PIN 4821 of `phc-password.json`, the personnel number as the host keeps it (four digits, a leading zero).
        assertEquals("op", "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b", auth.byLogin("0042", "4821")?.operatorId)
        assertNull(auth.byLogin("0042", "0000"))
        // The badge of `changes-people.json` is the code MRK-000742 under the site's salt, hashed with 100 000 iterations.
        assertEquals("8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b", auth.byBadge("MRK-000742")?.operatorId)
        assertNull(auth.byBadge("MRK-000743"))
        assertNotNull(auth.byLoginOnly("0042"))
    }

    @Test
    fun anOperatorTheOfficeAddsAfterThePairingIsOnlyHereAfterANewFeedRead() = runTest {
        val late = """{"hostId":"$hostId","rev":60,"hasMore":false,"items":[{"entity":"operators","id":"11111111-2222-4333-8444-555555555555","rev":60,"deleted":false,"data":{"login":"0077","name":"Пётр Сидоров","role":null,"pinPhc":"pbkdf2${'$'}sha256${'$'}100000${'$'}bWFya2lyby1waW4tc2FsdA==${'$'}3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU="}}]}"""
        val feed = Feed(ArrayDeque(listOf(fixture("changes-people.json"), late)))
        val reference = HostReferenceSync(db, db.deviceConfigDao(), MetaStore(db), HostApi(feed))
        reference.sync().getOrThrow()
        assertNull("not in the roster until the feed is read again", auth().byLoginOnly("0077"))
        reference.sync().getOrThrow()
        assertEquals("Пётр Сидоров", auth().byLoginOnly("0077")?.name)
    }
}
