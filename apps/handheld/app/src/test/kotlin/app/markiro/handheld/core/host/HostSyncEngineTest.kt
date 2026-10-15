package app.markiro.handheld.core.host

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.host.HostFactsFixtures.KM_A
import app.markiro.handheld.core.host.HostFactsFixtures.KM_B
import app.markiro.handheld.core.host.HostFactsFixtures.KM_C
import app.markiro.handheld.core.network.host.HostApi
import app.markiro.handheld.core.network.host.HostResult
import app.markiro.handheld.core.network.host.HostTransport
import app.markiro.handheld.core.network.host.TransportFailure
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.HostOutboxEntity
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class HostSyncEngineTest {
    private lateinit var db: HandheldDatabase

    @Before
    fun open() = runBlocking {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        db.deviceConfigDao().upsert(HostFactsFixtures.config(db))
        db.initializeRecoveryForTest()
        db.shiftDao().upsert(HostFactsFixtures.shift())
        HostFactsFixtures.pool(db)
    }

    @After
    fun close() = db.close()

    private class Post(var answer: HostResult) : HostTransport {
        val paths = mutableListOf<String>()
        val bodies = mutableListOf<String>()
        override suspend fun get(path: String): HostResult = error("no GET")
        override suspend fun post(path: String, body: String): HostResult {
            paths += path
            bodies += body
            return answer
        }
    }

    private fun ids(body: String) = Json.parseToJsonElement(body).jsonObject.getValue("records").jsonArray.map { it.jsonObject.getValue("id").jsonPrimitive.content }

    private fun uuid(n: Int) = "10000000-0000-4000-8000-%012d".format(n)

    /** A queued record that is already frozen: the engine's own half, without the freezer. */
    private suspend fun queue(vararg ids: String, kind: String = "scan", sourceKind: String = "test") = ids.forEachIndexed { i, id ->
        db.hostOutboxDao().insert(
            HostOutboxEntity(
                recordId = id, target = "facts", kind = kind, sourceKind = sourceKind, sourceKey = id, body = """{"id":"$id","kind":"$kind"}""",
                state = "queued", reason = null, createdAt = "2026-10-15T08:00:0${i % 10}.000Z",
            ),
        )
    }

    private fun receipts(vararg r: String) = HostResult.Ok(200, """{"receipts":[${r.joinToString(",")}]}""", null)

    private fun accepted(id: String) = """{"id":"$id","outcome":"accepted"}"""

    private fun engine(post: Post, revoked: () -> Unit = {}) =
        HostSyncEngine(db, { HostApi(post) }, HostAckMapper(db, now = { "2026-10-15T08:30:00.000Z" }), HostCalls { revoked() })

    @Test
    fun acceptedAndConflictLeaveTheQueueOthersRejectedGoToQuarantineWithTheHostsReason() = runTest {
        queue("a", "b", "c")
        val post = Post(
            receipts(
                accepted("a"),
                """{"id":"b","outcome":"conflict","code":"device_duplicate"}""",
                """{"id":"c","outcome":"rejected","code":"shift_closed"}""",
            ),
        )
        assertTrue(engine(post).drainAll())
        assertEquals(0, db.hostOutboxDao().queuedCount())
        assertEquals(listOf("c"), db.hostOutboxDao().quarantined().map { it.recordId })
        assertEquals("shift_closed", db.hostOutboxDao().quarantined().single().reason)
    }

    @Test
    fun theFixturesReceiptsSettleEachRecordOnItsOwn() = runTest {
        val answer = HostFactsFixtures.fixture("facts-response.json").getValue("receipts").jsonArray
        val named = answer.mapNotNull { it.jsonObject["id"]?.jsonPrimitive?.contentOrNullCompat() }
        queue(*named.toTypedArray())
        val post = Post(HostResult.Ok(200, HostFactsFixtures.fixture("facts-response.json").toString(), null))
        assertTrue(engine(post).drainAll())
        // accepted, conflict and the close that was already closed leave; the two rejections stay, with the host's own codes
        assertEquals(
            mapOf("7f4e0b2c-5d3a-4e9f-9c8b-2a4d6e8f0b32" to "invalid_record", "8a5f1c3d-6e4b-4fa0-8d9c-3b5e7f9a1c43" to "not_entered"),
            db.hostOutboxDao().quarantined().associate { it.recordId to it.reason },
        )
        assertEquals(0, db.hostOutboxDao().queuedCount())
    }

    @Test
    fun anUnreachableHostKeepsEveryRecordAndTheSameBytesGoAgainFromANewEngine() = runTest {
        db.outboxDao().insert(HostFactsFixtures.scanRow(KM_A, boxId = "8e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b"))
        db.outboxDao().insert(HostFactsFixtures.scanRow(KM_B, boxId = "8e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b"))
        val post = Post(HostResult.Failed(TransportFailure.UNREACHABLE))
        assertFalse(engine(post).drainAll())
        assertEquals(2, db.hostOutboxDao().queuedCount())
        val sent = ids(post.bodies[0])
        post.answer = receipts(*sent.map(::accepted).toTypedArray()) // the host's answer is lost once, then it comes
        assertTrue(engine(post).drainAll()) // a restart: another engine over the same Room
        assertEquals(0, db.hostOutboxDao().queuedCount())
        assertEquals("byte for byte", post.bodies[0], post.bodies[1])
        assertEquals(0, db.outboxDao().countNow())
    }

    @Test
    fun anAcceptedRecordIsNeverMadeAgainAndItsSourceLeavesWithIt() = runTest {
        val boxId = "8e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b"
        db.outboxDao().insert(HostFactsFixtures.scanRow(KM_A, boxId = boxId))
        db.boxDao().insert(HostFactsFixtures.closedBox(boxId, 1500))
        db.codeDao().insert(HostFactsFixtures.code(KM_A, boxId))
        db.shiftCloseDao().insert(HostFactsFixtures.shiftClose("ad7c3f5a-8b6e-4c2d-9f0a-5b7c9d1e3f65"))
        val post = Post(HostResult.Failed(TransportFailure.TIMEOUT))
        engine(post).drainAll()
        post.answer = receipts(*ids(post.bodies[0]).map(::accepted).toTypedArray())
        assertTrue(engine(post).drainAll())
        val sentOnce = post.bodies.size
        assertTrue(engine(post).drainAll())
        assertTrue(engine(post).drainAll())
        assertEquals("nothing is owed: no request", sentOnce, post.bodies.size)
        assertEquals(0, db.outboxDao().countNow())
        assertEquals(0, db.boxDao().unacked(10).size)
        assertEquals("accepted", db.shiftCloseDao().forShift(HostFactsFixtures.SHIFT)!!.state)
        assertEquals(0, db.hostOutboxDao().queuedCount() + db.hostOutboxDao().quarantinedCount())
        assertEquals(0, db.hostOutboxDao().observeOwed().first())
    }

    @Test
    fun theRecordsGoInTheOrderTheyWereFrozenAndInTheHostsWrapper() = runTest {
        queue(uuid(3), uuid(1), uuid(2))
        val post = Post(receipts())
        engine(post).drainAll()
        assertEquals(listOf(uuid(3), uuid(1), uuid(2)), ids(post.bodies.single()))
        assertEquals("/v1/device/facts", post.paths.single())
        assertTrue(post.bodies.single().startsWith("""{"records":["""))
    }

    @Test
    fun aQuarantinedRecordIsNotSentAgain() = runTest {
        queue("a", "b")
        db.hostOutboxDao().quarantine("a", "invalid_record")
        val post = Post(receipts(accepted("b")))
        engine(post).drainAll()
        assertEquals(listOf("b"), ids(post.bodies.single()))
        assertEquals(1, db.hostOutboxDao().quarantinedCount())
    }

    @Test
    fun aRecordWithoutAReceiptStaysQueuedAndAHostThatNamesNothingDoesNotHoldThePass() = runTest {
        queue("a", "b")
        val post = Post(receipts(accepted("a"), """{"id":null,"outcome":"rejected","code":"invalid_record"}"""))
        assertFalse(engine(post).drainAll())
        assertEquals(listOf("b"), db.hostOutboxDao().queuedFor("facts", 10).map { it.recordId })
        assertEquals(0, db.hostOutboxDao().quarantinedCount())
        assertEquals(listOf(listOf("a", "b"), listOf("b")), post.bodies.map(::ids))
    }

    @Test
    fun aRestoreInProgressIsARetryNotAQuarantine() = runTest {
        queue("a")
        val post = Post(HostResult.Ok(503, """{"error":{"code":"restore_pending","message":"m","details":{}}}""", 30L))
        assertFalse(engine(post).drainAll())
        assertEquals(1, db.hostOutboxDao().queuedCount())
        assertEquals(0, db.hostOutboxDao().quarantinedCount())
    }

    @Test
    fun aServerErrorAndAnIncompleteAnswerAreRetriesToo() = runTest {
        queue("a")
        assertFalse(engine(Post(HostResult.Ok(502, "bad gateway", null))).drainAll())
        assertFalse(engine(Post(HostResult.Ok(200, "<html>captive portal</html>", null))).drainAll())
        assertEquals(1, db.hostOutboxDao().queuedCount())
    }

    @Test
    fun aRejectedKeyRevokesAndKeepsTheQueueForSupport() = runTest {
        queue("a")
        var revoked = 0
        val post = Post(HostResult.Ok(401, """{"error":{"code":"unauthorized","message":"m","details":{"credential":"device"}}}""", null))
        assertFalse(engine(post, { revoked++ }).drainAll())
        assertEquals(1, revoked)
        assertEquals(1, db.hostOutboxDao().queuedCount())
    }

    @Test
    fun aBatchIsAtMostTheHostsLimitAndTheRestGoesInTheSamePass() = runTest {
        val all = (1..150).map { uuid(it) }
        queue(*all.toTypedArray())
        val post = Post(HostResult.Failed(TransportFailure.UNREACHABLE))
        val engine = engine(post)
        engine.drainAll()
        assertEquals(100, ids(post.bodies.single()).size)
        post.bodies.clear()
        // the host answers each batch with a receipt per record it was sent
        val answering = object : HostTransport {
            override suspend fun get(path: String): HostResult = error("no GET")
            override suspend fun post(path: String, body: String): HostResult {
                post.bodies += body
                return receipts(*ids(body).map(::accepted).toTypedArray())
            }
        }
        val second = HostSyncEngine(db, { HostApi(answering) }, HostAckMapper(db), HostCalls { })
        assertTrue(second.drainAll())
        assertEquals(listOf(100, 50), post.bodies.map { ids(it).size })
        assertEquals(all, post.bodies.flatMap { ids(it) })
    }

    @Test
    fun aScanTheHostHoldsAlreadyIsKeptAsAConflictOnTheDevice() = runTest {
        db.outboxDao().insert(HostFactsFixtures.scanRow(KM_C, boxId = "8e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b"))
        val post = Post(HostResult.Failed(TransportFailure.UNREACHABLE))
        engine(post).drainAll()
        val id = ids(post.bodies.single()).single()
        post.answer = HostResult.Ok(
            200,
            """{"receipts":[{"id":"$id","outcome":"conflict","details":{"winner":{"shiftId":"1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d","shiftNumber":"OCT26-003","deviceId":"2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e","scannedAt":"2026-10-08T05:58:41.090Z","sameDevice":false}}}]}""",
            null,
        )
        assertTrue(engine(post).drainAll())
        val conflict = db.conflictDao().observeAll().first().single()
        assertEquals(app.markiro.handheld.core.km.KmCodec.hash(app.markiro.handheld.core.km.KmCodec.canonicalize(KM_C)), conflict.codeHash)
        assertEquals("2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e", conflict.winningTerminalId)
        assertEquals("2026-10-08T05:58:41.090Z", conflict.winningScannedAt)
        assertEquals(0, db.outboxDao().countNow())
    }

    @Test
    fun aRejectedCloseIsAConflictOfItsShiftAndTheRecordStaysForSupport() = runTest {
        val eventId = "ad7c3f5a-8b6e-4c2d-9f0a-5b7c9d1e3f65"
        db.shiftCloseDao().insert(HostFactsFixtures.shiftClose(eventId))
        val post = Post(receipts("""{"id":"$eventId","outcome":"rejected","code":"invalid_record","details":{"field":"data.reasonCode"}}"""))
        assertTrue(engine(post).drainAll())
        val close = db.shiftCloseDao().forShift(HostFactsFixtures.SHIFT)!!
        assertEquals(Pair("conflict", "invalid_record"), close.state to close.conflictCode)
        assertEquals(listOf(eventId), db.hostOutboxDao().quarantined().map { it.recordId })
        assertEquals(0, db.hostOutboxDao().observeOwed().first())
    }

    @Test
    fun aDeviceOfTheCloudNeverSendsAnythingToTheHost() = runTest {
        db.deviceConfigDao().upsert(HostFactsFixtures.config(db, backend = "cloud"))
        db.outboxDao().insert(HostFactsFixtures.scanRow(KM_A, boxId = "8e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b"))
        queue("a")
        val post = Post(receipts(accepted("a")))
        assertTrue(engine(post).drainAll())
        assertEquals(0, post.bodies.size)
        assertEquals(1, db.outboxDao().countNow())
        assertEquals("nothing was frozen either", 1, db.hostOutboxDao().queuedCount())
    }

    @Test
    fun theCloudsEngineSendsNothingFromADeviceOfAHost() = runTest {
        db.outboxDao().insert(HostFactsFixtures.scanRow(KM_A, boxId = "8e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b"))
        var calls = 0
        val client = okhttp3.Call.Factory { calls++; throw java.io.IOException("the cloud was called") }
        val cloud = app.markiro.handheld.core.sync.SyncEngine(
            db = db, meta = app.markiro.handheld.core.storage.MetaStore(db), config = db.deviceConfigDao(),
            transport = app.markiro.handheld.core.sync.SyncTransport(client) { "https://admin.markiro.app" },
            json = Json, scope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Job()),
        )
        assertTrue(cloud.drainAll())
        assertEquals(0, calls)
        assertEquals(1, db.outboxDao().countNow())
    }
}

private fun kotlinx.serialization.json.JsonPrimitive.contentOrNullCompat(): String? = if (this is kotlinx.serialization.json.JsonNull) null else content
