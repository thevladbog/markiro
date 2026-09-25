package app.markiro.handheld.feature.shift

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.MainDispatcherRule
import app.markiro.handheld.core.box.ServerRange
import app.markiro.handheld.core.box.SsccPool
import app.markiro.handheld.core.network.BoxSsccTopUpDto
import app.markiro.handheld.core.network.BundleSsccDto
import app.markiro.handheld.core.network.NetworkModule
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import retrofit2.HttpException
import retrofit2.Response

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
class BoxSerialTopUpTest {
    @get:Rule val main = MainDispatcherRule()
    private lateinit var db: HandheldDatabase
    private lateinit var pool: SsccPool
    private val prefix = "468008990"

    @Before fun setUp() = runTest {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        db.deviceConfigDao().upsert(DeviceConfigEntity(
            deviceId = "dev-1", deviceName = "ТСД", tenantId = "t", organizationName = "ООО",
            lineId = "l1", lineName = "Линия", kind = "handheld", serverUrl = "http://x",
            pairedAt = 1L, activeShiftId = "s1",
        ))
        db.shiftDao().upsert(ShiftEntityFixtures.bundled("s1").copy(
            mode = "aggregation", boxCapacity = 20, ssccIssuerPrefix = prefix,
        ))
        db.initializeRecoveryForTest()
        pool = SsccPool(db)
    }

    @After fun tearDown() { db.close() }

    private fun block(from: Long, to: Long) = BundleSsccDto(prefix, 0, from, to, null)
    private fun coordinator(scope: kotlinx.coroutines.CoroutineScope, request: suspend (String) -> BoxSsccTopUpDto) =
        BoxSerialTopUp(db, pool, "s1", prefix, db.recovery.token(), scope, request)

    private suspend fun await(predicate: suspend () -> Boolean) = withContext(Dispatchers.IO) {
        withTimeout(5_000) { while (!predicate()) delay(10) }
    }

    @Test fun responseShapeDecodesExactly() {
        val dto = NetworkModule.json().decodeFromString<BoxSsccTopUpDto>(
            """{"blocks":[{"issuerPrefix":"468008990","extensionDigit":0,"fromSerial":2001,"toSerial":4000,"consumedThroughSerial":null}],"revokedFrom":[],"issuerProblem":null}""",
        )
        assertEquals(listOf(block(2001, 4000)), dto.blocks)
    }

    @Test fun onlyChecksAtLowWaterAndKeepsOldRangeFirst() = runTest {
        pool.addRange(ServerRange(prefix, 0, 1, 2000, null))
        var calls = 0
        val topUp = coordinator(backgroundScope) { calls++; BoxSsccTopUpDto(listOf(block(2001, 4000)), emptyList(), null) }
        topUp.nudge()?.join()
        assertEquals(0, calls)
        repeat(1600) { pool.burn(prefix, 0) }
        topUp.nudge()?.join()
        assertEquals(1, calls)
        assertEquals(1601L, pool.burn(prefix, 0))
        assertEquals(2399L, pool.remaining(prefix, 0))
        topUp.stop()
    }

    @Test fun concurrentNudgesAreSingleFlight() = runTest {
        assertTrue(db.recovery.valid(db.recovery.token()))
        assertEquals("s1", db.deviceConfigDao().get()?.activeShiftId)
        assertEquals(prefix, db.shiftDao().get("s1")?.ssccIssuerPrefix)
        assertEquals(0L, pool.remaining(prefix, 0))
        val gate = CompletableDeferred<Unit>()
        var calls = 0
        val topUp = coordinator(backgroundScope) { calls++; gate.await(); BoxSsccTopUpDto(listOf(block(1, 2000)), emptyList(), null) }
        val pending = topUp.nudge()
        topUp.nudge(); runCurrent()
        await { calls == 1 }
        assertEquals(1, calls)
        gate.complete(Unit); pending?.join()
        assertEquals(2000L, pool.remaining(prefix, 0))
        topUp.stop()
    }

    @Test fun oldServer404DoesNotSpinAndNetworkFailureRetriesLater() = runTest {
        var calls = 0
        val unsupported = coordinator(backgroundScope) {
            calls++
            throw HttpException(Response.error<Unit>(404, okhttp3.ResponseBody.create(null, "")))
        }
        unsupported.nudge()?.join()
        advanceTimeBy(120_000); runCurrent()
        unsupported.nudge(); runCurrent()
        assertEquals(1, calls)
        unsupported.stop()

        calls = 0
        val retry = coordinator(backgroundScope) {
            calls++
            if (calls == 1) throw java.io.IOException("offline")
            BoxSsccTopUpDto(listOf(block(1, 2000)), emptyList(), null)
        }
        retry.nudge()?.join()
        retry.nudge(); runCurrent()
        assertEquals(1, calls)
        advanceTimeBy(15_000); runCurrent()
        await { calls == 2 }
        assertEquals(2, calls)
        retry.stop()
    }

    @Test fun lateResponseAfterShiftChangeCannotWriteAndPalletsStayUntouched() = runTest {
        pool.addRange(ServerRange(prefix, 1, 1, 10, null))
        val gate = CompletableDeferred<Unit>()
        val started = CompletableDeferred<Unit>()
        val topUp = coordinator(backgroundScope) {
            started.complete(Unit)
            gate.await()
            BoxSsccTopUpDto(listOf(block(1, 2000)), listOf(1), null)
        }
        val pending = topUp.nudge(); runCurrent()
        await { started.isCompleted }
        db.deviceConfigDao().get()?.let { db.deviceConfigDao().upsert(it.copy(activeShiftId = "s2")) }
        gate.complete(Unit); pending?.join()
        assertEquals(0L, pool.remaining(prefix, 0))
        assertEquals(10L, pool.remaining(prefix, 1))
        topUp.stop()
    }

    @Test fun lateResponseAfterCredentialSealCannotWrite() = runTest {
        val gate = CompletableDeferred<Unit>()
        val started = CompletableDeferred<Unit>()
        val token = db.recovery.token()
        val topUp = coordinator(backgroundScope) {
            started.complete(Unit)
            gate.await()
            BoxSsccTopUpDto(listOf(block(1, 2000)), emptyList(), null)
        }
        val pending = topUp.nudge(); runCurrent()
        await { started.isCompleted }
        db.recovery.reject(token)
        gate.complete(Unit); pending?.join()
        assertEquals(0L, pool.remaining(prefix, 0))
        topUp.stop()
    }

    @Test fun malformedPalletGrantCannotMutateEitherPool() = runTest {
        pool.addRange(ServerRange(prefix, 1, 1, 10, null))
        val topUp = coordinator(backgroundScope) {
            BoxSsccTopUpDto(listOf(BundleSsccDto(prefix, 1, 1, 2000, null)), listOf(1), null)
        }
        topUp.nudge()?.join()
        assertEquals(0L, pool.remaining(prefix, 0))
        assertEquals(10L, pool.remaining(prefix, 1))
        topUp.stop()
    }

    @Test fun revokedRangeIsDroppedBeforeNewGrantAndRestartKeepsCursor() = runTest {
        pool.addRange(ServerRange(prefix, 0, 1, 2000, null))
        val topUp = coordinator(backgroundScope) { BoxSsccTopUpDto(listOf(block(2001, 4000)), listOf(1), null) }
        repeat(1600) { pool.burn(prefix, 0) }
        topUp.nudge()?.join()
        assertEquals(2001L, pool.burn(prefix, 0))
        assertEquals(1999L, SsccPool(db).remaining(prefix, 0))
        assertTrue(pool.remaining(prefix, 1) == 0L)
        topUp.stop()
    }
}
