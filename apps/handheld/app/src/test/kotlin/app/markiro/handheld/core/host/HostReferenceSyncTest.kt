package app.markiro.handheld.core.host

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.network.CredentialDto
import app.markiro.handheld.core.network.DeviceDto
import app.markiro.handheld.core.network.PairResponse
import app.markiro.handheld.core.network.host.HostApi
import app.markiro.handheld.core.network.host.HostApiError
import app.markiro.handheld.core.network.host.HostFailure
import app.markiro.handheld.core.network.host.HostResult
import app.markiro.handheld.core.network.host.HostTransport
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.storage.DeviceRecovery
import app.markiro.handheld.core.storage.HostPairing
import app.markiro.handheld.core.storage.InMemoryCredentialStore
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class HostReferenceSyncTest {
    private lateinit var db: HandheldDatabase
    private val hostId = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f"

    private class FeedTransport(val pages: ArrayDeque<String>) : HostTransport {
        val asked = mutableListOf<String>()
        override suspend fun get(path: String): HostResult = HostResult.Ok(200, pages.removeFirst(), null).also { asked += path }
        override suspend fun post(path: String, body: String): HostResult = error("the feed is read, not written")
    }

    @Before
    fun open() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        // Paired the way the app pairs: a synthetic config with a pin has no recovery row that owns it.
        kotlinx.coroutines.runBlocking {
            val recovery = DeviceRecovery(db, InMemoryCredentialStore()).also { it.initialize() }
            val origin = "https://192.168.1.10:45710"
            recovery.restore(
                PairResponse(DeviceDto("d1", "ТСД", "handheld", hostId, "", null), CredentialDto("k1", origin), emptyList()),
                origin,
                HostPairing("ab".repeat(32), hostId, listOf("192.168.1.10")),
            )
            db.deviceConfigDao().get()!!.let { db.deviceConfigDao().upsert(it.copy(lineId = "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61")) }
        }
    }

    @After
    fun close() = db.close()

    private fun fixture(name: String) =
        checkNotNull(javaClass.classLoader?.getResource(name)) { name }.readText()

    private fun sync(vararg pages: String): Pair<HostReferenceSync, FeedTransport> {
        val transport = FeedTransport(ArrayDeque(pages.toList()))
        return HostReferenceSync(db, db.deviceConfigDao(), MetaStore(db), HostApi(transport)) to transport
    }

    @Test
    fun theFeedGivesOperatorsTheirBadgesAndTheirPermissionToBuildPallets() = runTest {
        val (reference, transport) = sync(fixture("changes-people.json"))
        reference.sync().getOrThrow()
        val operator = db.operatorDao().all().single()
        assertEquals("0042", operator.login)
        assertEquals("Анна Кузнецова", operator.name)
        assertTrue(operator.pinHash.startsWith("pbkdf2$"))
        assertTrue(operator.active)
        assertEquals(listOf("c4e2a1b3-5d6f-4a8b-9c0d-1e2f3a4b5c6d"), db.operatorBadgeDao().all().map { it.badgeId })
        assertTrue(db.palletPermissionDao().get(operator.operatorId)!!.canBuildPallets)
        assertEquals(57L, db.deviceConfigDao().get()!!.hostRev)
        assertEquals(listOf("/v1/changes?since=0&limit=500"), transport.asked)
    }

    @Test
    fun aTombstoneRemovesTheOperatorAndItsBadgesAndASecondSyncAsksFromTheRevision() = runTest {
        val (reference, transport) = sync(
            fixture("changes-people.json"),
            """{"hostId":"$hostId","rev":60,"hasMore":false,"items":[{"entity":"operators","id":"8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b","rev":60,"deleted":true}]}""",
        )
        reference.sync().getOrThrow()
        reference.sync().getOrThrow()
        assertEquals(emptyList<Any>(), db.operatorDao().all())
        assertEquals(emptyList<Any>(), db.operatorBadgeDao().all())
        assertNull(db.palletPermissionDao().get("8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b"))
        assertEquals(listOf("/v1/changes?since=0&limit=500", "/v1/changes?since=57&limit=500"), transport.asked)
    }

    @Test
    fun aRecordOfAccessThatCannotBeReadRemovesTheLocalCopyInsteadOfKeepingIt() = runTest {
        val (reference, _) = sync(
            fixture("changes-people.json"),
            """{"hostId":"$hostId","rev":58,"hasMore":false,"items":[{"entity":"operators","id":"8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b","rev":58,"deleted":false,"data":{"login":"0042","name":"Анна","pinPhc":"not a verifier"}}]}""",
        )
        reference.sync().getOrThrow()
        assertEquals(1, db.operatorDao().all().size)
        reference.sync().getOrThrow()
        assertEquals("a verifier the app cannot read is no way in", emptyList<Any>(), db.operatorDao().all())
    }

    @Test
    fun aFeedOfAnotherHostStopsTheSyncAndWritesNothing() = runTest {
        val (reference, _) = sync(fixture("changes-people.json").replace(hostId, "00000000-0000-4000-8000-000000000000"))
        val failure = reference.sync().exceptionOrNull()
        assertTrue("$failure", failure is HostApiError && failure.failure == HostFailure.Constraint("host_mismatch"))
        assertEquals(emptyList<Any>(), db.operatorDao().all())
        assertNull(db.deviceConfigDao().get()!!.hostRev)
    }

    @Test
    fun pagesAreAppliedAsLongAsTheHostHasMore() = runTest {
        val first = """{"hostId":"$hostId","rev":10,"hasMore":true,"items":[{"entity":"operators","id":"8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b","rev":10,"deleted":false,"data":{"login":"0042","name":"Анна","pinPhc":"pbkdf2${'$'}sha256${'$'}100000${'$'}bWFya2lyby1waW4tc2FsdA==${'$'}3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU="}}]}"""
        val (reference, transport) = sync(first, fixture("changes-people.json"))
        reference.sync().getOrThrow()
        assertEquals(listOf("/v1/changes?since=0&limit=500", "/v1/changes?since=10&limit=500"), transport.asked)
        assertEquals(57L, db.deviceConfigDao().get()!!.hostRev)
    }

    @Test
    fun productsTemplatesAndTheDefaultsMakeTheLabelTemplatesOfPallets() = runTest {
        val catalog = fixture("changes-catalog.json")
        val (reference, _) = sync(catalog)
        reference.sync().getOrThrow()
        val products = db.palletProductDao().all()
        assertTrue("an archived product is not offered", products.none { it.gtin14 == "04600682000020" })
        val milk = products.single { it.gtin14 == "04600682000013" }
        assertEquals(40, milk.palletBoxCapacity)
        assertEquals("Молоко 3,2%", milk.printName)
        // Whatever the fixture's pallet defaults name, each resolves to a template the feed carried.
        for (row in db.palletLabelTemplateDao().all()) assertNotNull(row.specJson)
        assertEquals("ООО «Атолл»", db.deviceConfigDao().get()!!.organizationName)
    }

    @Test
    fun theNameOfTheDevicesOwnLineComesFromTheFeed() = runTest {
        val (reference, _) = sync(fixture("changes-response.json"))
        reference.sync().getOrThrow()
        assertEquals("Линия 2", db.deviceConfigDao().get()!!.lineName)
    }

    @Test
    fun aHostCodeReleaseFreesOnlyTheNamedClosedBoxAndKeepsThePendingRawOutbox() = runTest {
        val box=app.markiro.handheld.core.storage.BoxEntity("box-1","shift-1","046012345600000016","2026-10-30T10:00:00Z","2026-10-30T10:01:00Z",null,"printed",null,"ack")
        db.boxDao().insert(box)
        db.codeDao().insert(app.markiro.handheld.core.storage.CodeEntity("hash-1","shift-1","04601234567015","one","2026-10-30T10:00:00Z","box-1"))
        db.codeDao().insert(app.markiro.handheld.core.storage.CodeEntity("hash-2","other-shift","04601234567015","two","2026-10-30T10:00:00Z","other-box"))
        db.outboxDao().insert(app.markiro.handheld.core.storage.OutboxEntity(shiftId="shift-1",raw="frozen-source",verdict="accepted",scannedAt="2026-10-30T10:00:00Z",operatorId=null,codeHash="hash-1",gtin14="04601234567015",serial="one",boxId="box-1"))
        val (reference,_)=sync("""{"hostId":"$hostId","rev":58,"hasMore":false,"items":[{"entity":"code_releases","id":"box-1","rev":58,"deleted":false,"data":{"shiftId":"shift-1","documentId":"doc-1","releasedAt":"2026-10-30T10:02:00.000Z","codeCount":1}}]}""")
        reference.sync().getOrThrow()
        assertEquals(1,db.outboxDao().countNow())
        assertEquals(0,db.boxDao().itemCount("box-1"))
        assertEquals(1,db.boxDao().itemCount("other-box"))
        assertEquals("2026-10-30T10:02:00.000Z",db.boxDao().get("box-1")?.disassembledAt)
    }
}
