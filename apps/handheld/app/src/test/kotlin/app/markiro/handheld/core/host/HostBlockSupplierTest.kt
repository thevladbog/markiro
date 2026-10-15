package app.markiro.handheld.core.host

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.box.SsccPool
import app.markiro.handheld.core.network.host.HostApi
import app.markiro.handheld.core.network.host.HostResult
import app.markiro.handheld.core.network.host.HostTransport
import app.markiro.handheld.core.network.host.TransportFailure
import app.markiro.handheld.core.pallets.SsccBlockApplier
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class HostBlockSupplierTest {
    private lateinit var db: HandheldDatabase

    @Before
    fun open() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        db.initializeRecoveryForTest()
    }

    @After
    fun close() = db.close()

    /** Answers each POST with the next scripted result and keeps what was sent as `"<path> <body>"`. */
    private class Script(val answers: ArrayDeque<HostResult>) : HostTransport {
        val bodies = mutableListOf<String>()
        override suspend fun get(path: String): HostResult = error("no GET")
        override suspend fun post(path: String, body: String): HostResult = answers.removeFirst().also { bodies += "$path $body" }
    }

    private fun block(id: String, from: Long, to: Long, extension: Int = 0) =
        HostResult.Ok(200, """{"id":"$id","issuerPrefix":"460068200","extension":$extension,"fromSerial":$from,"toSerial":$to}""", null)

    private fun supplier(script: Script): HostBlockSupplier {
        val pool = SsccPool(db)
        return HostBlockSupplier(db, MetaStore(db), HostApi(script), pool, SsccBlockApplier(pool), requestId = { "req-${script.bodies.size}" })
    }

    @Test
    fun aBlockIsRequestedWhenThePoolIsDryAndKeepsTheIdOfItsBlock() = runTest {
        val script = Script(ArrayDeque(listOf(block("b1000000-0000-4000-8000-000000000001", 1500, 3499))))
        supplier(script).ensure("460068200", 0).getOrThrow()
        assertEquals(1, script.bodies.size)
        val range = db.ssccPoolDao().lowestWithRoom("460068200", 0)!!
        assertEquals(Triple(1500L, 3499L, 1500L), Triple(range.fromSerial, range.toSerial, range.nextSerial))
        assertEquals("b1000000-0000-4000-8000-000000000001", range.blockId)
        assertNull("the request id is forgotten once the block is held", MetaStore(db).get("host_block_request:0"))
    }

    @Test
    fun aRequestThatGotNoAnswerIsRepeatedUnderTheSameIdAndANeededBlockIsNotAskedTwice() = runTest {
        val script = Script(
            ArrayDeque(
                listOf(HostResult.Failed(TransportFailure.TIMEOUT), block("b1000000-0000-4000-8000-000000000001", 1500, 3499)),
            ),
        )
        val supplier = supplier(script)
        assertEquals(true, supplier.ensure("460068200", 0).isFailure)
        supplier.ensure("460068200", 0).getOrThrow()
        val ids = script.bodies.map { Regex("\"requestId\":\"([^\"]+)\"").find(it)!!.groupValues[1] }
        assertEquals("a retry carries the same request id: the host answers the same block", ids[0], ids[1])
        supplier.ensure("460068200", 0).getOrThrow()
        assertEquals("the pool is full: no third request", 2, script.bodies.size)
    }

    @Test
    fun aPoolBelowHalfABlockAsksForTheNextOne() = runTest {
        val script = Script(ArrayDeque(listOf(block("b1000000-0000-4000-8000-000000000001", 1500, 3499), block("b1000000-0000-4000-8000-000000000002", 3500, 5499))))
        val supplier = supplier(script)
        supplier.ensure("460068200", 0).getOrThrow()
        val pool = SsccPool(db)
        repeat(1100) { pool.burn("460068200", 0) }
        supplier.ensure("460068200", 0).getOrThrow()
        assertEquals(2, script.bodies.size)
        assertEquals(true, db.ssccPoolDao().remaining("460068200", 0) > 900)
    }

    @Test
    fun theBlocksHeldAreToldToARestoredHostInBatchesOf64AndARefusalIsNotHidden() = runTest {
        val pool = SsccPool(db)
        repeat(65) { i ->
            val from = 1000L * i
            pool.addRange(app.markiro.handheld.core.box.ServerRange("460068200", 0, from, from + 999, null, "b${i.toString().padStart(7, '0')}-0000-4000-8000-000000000001"))
        }
        val ok = HostResult.Ok(200, """{"results":[]}""", null)
        val refused = HostResult.Ok(200, """{"results":[{"id":"x","outcome":"refused","code":"block_overlap"}]}""", null)
        val script = Script(ArrayDeque(listOf(ok, refused)))
        val failure = supplier(script).registerKnown().exceptionOrNull()
        assertEquals(2, script.bodies.size)
        assertEquals(true, script.bodies[0].startsWith("/v1/device/sscc/blocks/known ") && script.bodies[0].contains("\"more\":true"))
        assertEquals(false, script.bodies[1].contains("\"more\""))
        assertEquals(true, failure is app.markiro.handheld.core.network.host.HostApiError)
    }
}
