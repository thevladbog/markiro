package app.markiro.handheld.core.writeoff

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.network.NetworkModule
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.storage.WriteoffOutboxEntity
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import app.markiro.handheld.core.sync.SyncTransport
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class WriteoffSyncEngineTest {
    private lateinit var db: HandheldDatabase
    private lateinit var server: MockWebServer
    private lateinit var meta: MetaStore
    private val engineScope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
    private val clock = 1_757_845_320_000L

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        db.initializeRecoveryForTest()
        server = MockWebServer().also { it.start() }
        meta = MetaStore(db)
    }

    @After
    fun tearDown() {
        engineScope.cancel()
        runCatching { server.shutdown() }
        db.close()
    }

    private fun engine() = WriteoffSyncEngine(
        db, meta, SyncTransport(OkHttpClient()) { server.url("/").toString() }, NetworkModule.strictJson(), engineScope,
        clock = { clock },
    )

    private fun pending(id: String, seq: Long, body: String, units: Int = 1, boxes: Int = 0) = WriteoffOutboxEntity(
        documentId = id, deviceSeq = seq, operatorId = "op-1", reasonId = "r-1", reasonName = "Бой", unitCount = units,
        boxCount = boxes, requestJson = body, createdAt = "2026-09-14T10:00:00.000Z", state = "pending", orderNo = null,
        acceptedCount = null, conflictsJson = null, lastAttemptAt = null,
    )

    private fun body(seq: Long, raw: String) =
        """{"deviceSeq":$seq,"operatorId":"op-1","writeoffReasonId":"r-1","items":[{"rawKm":"$raw"}],"boxes":[],"createdAt":"2026-09-14T10:00:00.000Z"}"""

    private fun okResult(orderNo: String = "ORD-26-0417", items: Int = 1, conflicts: String = "[]", boxConflicts: String = "[]") =
        """{"orderNo":"$orderNo","status":"pending","itemCount":$items,"conflicts":$conflicts,"boxConflicts":$boxConflicts,"acceptedBoxes":[]}"""

    @Test
    fun sendsPendingDocumentAndMarksSent() = runTest {
        db.writeoffOutboxDao().insert(pending("d-1", seq = 1, body = body(1, "x")))
        server.enqueue(MockResponse().setBody(okResult()))
        val engine = engine()
        assertTrue(engine.drainAll())
        val row = db.writeoffOutboxDao().get("d-1")!!
        assertEquals("sent", row.state)
        assertEquals("ORD-26-0417", row.orderNo)
        assertEquals(1, row.acceptedCount)
        assertNotNull(row.lastAttemptAt)
        assertEquals("/station/writeoffs", server.takeRequest().path)
        assertNull(meta.get(MetaStore.writeoffPin("d-1")))
        assertEquals(clock.toString(), meta.get(MetaStore.WRITEOFF_LAST_SUCCESS_AT))
        assertEquals(0, engine.state.first { it.pending == 0 }.pending)
    }

    /**
     * The server answers a replayed `deviceSeq` with the original document, so the
     * retry must carry the bytes the operator confirmed and nothing rebuilt.
     */
    @Test
    fun retryResendsTheSameBytes() = runTest {
        val frozen = body(2, "y")
        db.writeoffOutboxDao().insert(pending("d-2", seq = 2, body = frozen))
        server.enqueue(MockResponse().setResponseCode(503))
        val engine = engine()
        assertFalse(engine.drainAll())
        assertEquals("pending", db.writeoffOutboxDao().get("d-2")!!.state)
        assertNotNull(meta.get(MetaStore.writeoffPin("d-2")))
        server.enqueue(MockResponse().setBody(okResult()))
        assertTrue(engine.drainAll())
        assertEquals(frozen, server.takeRequest().body.readUtf8())
        assertEquals(frozen, server.takeRequest().body.readUtf8())
    }

    /**
     * A refusal the server has already decided must settle, or it would block every
     * later document: the queue is strict FIFO by `deviceSeq`.
     */
    @Test
    fun serverRejectionIsTerminalAndReleasesTheQueue() = runTest {
        db.writeoffOutboxDao().insert(pending("d-3", seq = 3, body = body(3, "a")))
        db.writeoffOutboxDao().insert(pending("d-4", seq = 4, body = body(4, "b")))
        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"message":"Unknown or archived writeoff reason"}"""))
        server.enqueue(MockResponse().setBody(okResult(orderNo = "ORD-26-0418")))
        assertTrue(engine().drainAll())
        val rejected = db.writeoffOutboxDao().get("d-3")!!
        assertEquals("rejected", rejected.state)
        assertTrue(rejected.conflictsJson!!.contains("Unknown or archived writeoff reason"))
        assertNull(rejected.orderNo)
        assertEquals("sent", db.writeoffOutboxDao().get("d-4")!!.state)
        assertEquals(2, server.requestCount)
        assertNull(meta.get(MetaStore.writeoffPin("d-3")))
    }

    /** Losing the right to write off is about this document; the operator must be told. */
    @Test
    fun forbiddenSettlesTheDocumentAndRaisesDenied() = runTest {
        db.writeoffOutboxDao().insert(pending("d-5", seq = 5, body = body(5, "c")))
        server.enqueue(MockResponse().setResponseCode(403).setBody("""{"message":"Operator may not write off"}"""))
        val engine = engine()
        engine.drainAll()
        assertEquals("rejected", db.writeoffOutboxDao().get("d-5")!!.state)
        assertTrue(engine.state.first { it.denied }.denied)
    }

    /**
     * An unauthenticated device is not a decision about this document. Discarding
     * confirmed production work over a credential problem would be data loss.
     */
    @Test
    fun unauthenticatedKeepsTheDocumentQueued() = runTest {
        db.writeoffOutboxDao().insert(pending("d-6", seq = 6, body = body(6, "d")))
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"message":"Unauthorized"}"""))
        assertFalse(engine().drainAll())
        assertEquals("pending", db.writeoffOutboxDao().get("d-6")!!.state)
        assertNotNull(meta.get(MetaStore.writeoffPin("d-6")))
    }

    @Test
    fun partialAcceptanceKeepsTheConflicts() = runTest {
        db.writeoffOutboxDao().insert(pending("d-7", seq = 7, body = body(7, "e"), units = 2))
        server.enqueue(MockResponse().setBody(okResult(orderNo = "ORD-26-0419", conflicts = """[{"rawKm":"dup","reason":"duplicate"}]""")))
        engine().drainAll()
        val row = db.writeoffOutboxDao().get("d-7")!!
        assertEquals(1, row.acceptedCount)
        assertTrue(row.conflictsJson!!.contains("duplicate"))
    }

    /** A box conflict carries no bottle count when the server never knew the box. */
    @Test
    fun boxConflictsSurviveTheRoundTrip() = runTest {
        db.writeoffOutboxDao().insert(pending("d-8", seq = 8, body = body(8, "f"), units = 0, boxes = 2))
        server.enqueue(
            MockResponse().setBody(
                okResult(orderNo = "ORD-26-0420", items = 0, boxConflicts = """[{"sscc":"046000000000000018","bottleCount":null,"reason":"unknown_box"}]"""),
            ),
        )
        engine().drainAll()
        assertTrue(db.writeoffOutboxDao().get("d-8")!!.conflictsJson!!.contains("unknown_box"))
    }

    @Test
    fun pendingSurvivesEngineRestart() = runTest {
        db.writeoffOutboxDao().insert(pending("d-9", seq = 9, body = body(9, "g")))
        assertEquals(1, engine().state.first { it.pending == 1 }.pending)
        assertEquals(1, engine().state.first { it.pending == 1 }.pending)
    }

    /** History is bounded, but a document still waiting for the server never is. */
    @Test
    fun prunesSettledHistoryAndNeverPending() = runTest {
        repeat(22) { n ->
            db.writeoffOutboxDao().insert(pending("s-$n", seq = n.toLong(), body = body(n.toLong(), "k$n")))
            server.enqueue(MockResponse().setBody(okResult(orderNo = "ORD-$n")))
        }
        db.writeoffOutboxDao().insert(pending("last", seq = 99, body = body(99, "z")))
        server.enqueue(MockResponse().setResponseCode(503))
        assertFalse(engine().drainAll())
        assertEquals(20, db.writeoffOutboxDao().observeRecent(50).first().count { it.state == "sent" })
        assertEquals("pending", db.writeoffOutboxDao().get("last")!!.state)
    }
}
