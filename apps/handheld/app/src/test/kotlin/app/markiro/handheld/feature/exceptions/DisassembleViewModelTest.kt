package app.markiro.handheld.feature.exceptions

import androidx.lifecycle.SavedStateHandle
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.MainDispatcherRule
import app.markiro.handheld.R
import app.markiro.handheld.core.auth.OperatorRecord
import app.markiro.handheld.core.exceptions.DisassembleReason
import app.markiro.handheld.core.exceptions.ExceptionEngine
import app.markiro.handheld.core.scan.ScanEvent
import app.markiro.handheld.core.scan.ScanRouterAdapter
import app.markiro.handheld.core.storage.BoxEntity
import app.markiro.handheld.core.storage.CodeEntity
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.feature.signin.SessionHolder
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class DisassembleViewModelTest {
    @get:Rule
    val main = MainDispatcherRule()

    private lateinit var db: HandheldDatabase
    private val scans = MutableSharedFlow<ScanEvent>(extraBufferCapacity = 4)
    private val session = SessionHolder().apply {
        signIn(OperatorRecord("op-1", "Иванова Анна", "4127", "operator", "x", null, true))
    }
    private val sscc = "046800899000000018"

    @Before
    fun setUp() = runTest {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        db.deviceConfigDao().upsert(
            DeviceConfigEntity(
                deviceId = "dev-1", deviceName = "ТСД 1", tenantId = "t", organizationName = "ООО",
                lineId = "l1", lineName = "Линия 2", kind = "handheld", serverUrl = "http://x", pairedAt = 1L,
            ),
        )
    }

    @After
    fun tearDown() {
        try {
            main.cancelAndJoinModels()
        } finally {
            db.close()
        }
    }

    private suspend fun closedBox(
        id: String = "box-1",
        number: String = sscc,
        units: Int = 2,
        shiftId: String = "s1",
    ) {
        db.boxDao().insert(
            BoxEntity(
                boxId = id, shiftId = shiftId, sscc = number, openedAt = "2026-09-11T07:00:00.000Z",
                closedAt = "2026-09-11T07:30:00.000Z", operatorId = "op-1", printState = "printed",
                printReason = null, ackedAt = "2026-09-11T07:31:00.000Z",
            ),
        )
        repeat(units) { n ->
            db.codeDao().insert(
                CodeEntity("$id-$n".padEnd(64, 'f'), shiftId, "04600000000015", "$n", "2026-09-11T07:0$n:00.000Z", id),
            )
        }
    }

    private fun vm() = main.track(
        DisassembleViewModel(
            db, ExceptionEngine(db), session, ScanRouterAdapter(scans),
            SavedStateHandle(mapOf("shiftId" to "s1")),
        ),
    )

    /**
     * Waits for the view model's own collector before emitting.
     *
     * `step` starts at `ScanBox`, so awaiting that state returns on the initial
     * value without ever letting `init`'s collector run. A scan emitted into a
     * `SharedFlow` with no subscribers is dropped, and the test then waits out
     * the clock for a step that will never arrive.
     */
    private suspend fun scan(raw: String) {
        scans.subscriptionCount.first { it > 0 }
        scans.emit(ScanEvent(raw, null, "debug", 0))
    }

    private suspend fun refusedMessage(vm: DisassembleViewModel): Int =
        (vm.step.first { it is DisassembleStep.Refused } as DisassembleStep.Refused).message

    @Test
    fun scanningAClosedBoxLabelAdvancesToTheReason() = runTest {
        closedBox(units = 12)
        val vm = vm()
        vm.step.first { it is DisassembleStep.ScanBox }
        scan("(00)$sscc")
        val step = vm.step.first { it is DisassembleStep.Reason } as DisassembleStep.Reason
        assertEquals("box-1", step.boxId)
        assertEquals(12, step.units)
        assertEquals(sscc, step.sscc)
    }

    @Test
    fun scanningAnUnknownSsccRefuses() = runTest {
        closedBox()
        val vm = vm()
        vm.step.first { it is DisassembleStep.ScanBox }
        scan("046800899000000025")
        assertEquals(R.string.disassemble_unknown_sscc, refusedMessage(vm))
        assertEquals(0, db.boxExceptionDao().unackedCount())
    }

    /** A unit's own code is not a box label and must not be read as one. */
    @Test
    fun scanningAUnitCodeRefuses() = runTest {
        closedBox()
        val vm = vm()
        vm.step.first { it is DisassembleStep.ScanBox }
        scan("0104600682000013215Y7HG9")
        assertEquals(R.string.disassemble_unknown_sscc, refusedMessage(vm))
    }

    /** A box of another shift is out of reach: this is the current shift's screen. */
    @Test
    fun aBoxOfAnotherShiftIsNotFound() = runTest {
        closedBox(shiftId = "s2")
        val vm = vm()
        vm.step.first { it is DisassembleStep.ScanBox }
        scan(sscc)
        assertEquals(R.string.disassemble_unknown_sscc, refusedMessage(vm))
    }

    /** An open box has no label to scan, so this is reached by its number alone. */
    @Test
    fun anOpenBoxIsRefusedAndPointedAtClear() = runTest {
        db.boxDao().insert(
            BoxEntity(
                boxId = "box-open", shiftId = "s1", sscc = sscc, openedAt = "2026-09-11T07:00:00.000Z",
                closedAt = null, operatorId = "op-1", printState = "pending", printReason = null, ackedAt = null,
            ),
        )
        val vm = vm()
        vm.step.first { it is DisassembleStep.ScanBox }
        scan(sscc)
        assertEquals(R.string.disassemble_not_closed, refusedMessage(vm))
    }

    @Test
    fun confirmingRetiresTheBoxReleasesUnitsAndQueuesTheFact() = runTest {
        closedBox(units = 2)
        val vm = vm()
        vm.step.first { it is DisassembleStep.ScanBox }
        scan(sscc)
        vm.step.first { it is DisassembleStep.Reason }
        vm.chooseReason(DisassembleReason.WRONG_PRODUCT)
        vm.step.first { it is DisassembleStep.Confirm }
        vm.confirm()
        vm.step.first { it is DisassembleStep.Retired }
        assertNotNull(db.boxDao().get("box-1")?.disassembledAt)
        assertEquals(0, db.boxDao().itemCount("box-1"))
        val queued = db.boxExceptionDao().sendable(Long.MAX_VALUE, 10).single()
        assertEquals("disassemble", queued.kind)
        assertEquals("Неверный товар", queued.reason)
        assertEquals("box-1", queued.boxId)
    }

    @Test
    fun aRetiredBoxCannotBeRetiredTwice() = runTest {
        closedBox()
        db.boxDao().markDisassembled("box-1", "2026-09-11T08:00:00.000Z")
        val vm = vm()
        vm.step.first { it is DisassembleStep.ScanBox }
        scan(sscc)
        // A retired box is no longer findable by its number at all.
        assertEquals(R.string.disassemble_unknown_sscc, refusedMessage(vm))
        assertEquals(0, db.boxExceptionDao().unackedCount())
    }

    /** Nothing is applied until the third step. */
    @Test
    fun leavingAtTheReasonStepQueuesNothing() = runTest {
        closedBox()
        val vm = vm()
        vm.step.first { it is DisassembleStep.ScanBox }
        scan(sscc)
        vm.step.first { it is DisassembleStep.Reason }
        vm.cancel()
        assertEquals(0, db.boxExceptionDao().unackedCount())
        assertNull(db.boxDao().get("box-1")?.disassembledAt)
    }

    /** A second scan while a box is already identified must not re-target the flow. */
    @Test
    fun aScanArrivingAfterTheFirstStepIsIgnored() = runTest {
        closedBox()
        closedBox(id = "box-2", number = "046800899000000025")
        val vm = vm()
        vm.step.first { it is DisassembleStep.ScanBox }
        scan(sscc)
        vm.step.first { it is DisassembleStep.Reason }
        scan("046800899000000025")
        vm.chooseReason(DisassembleReason.WRONG_PRODUCT)
        assertEquals("box-1", (vm.step.first { it is DisassembleStep.Confirm } as DisassembleStep.Confirm).boxId)
    }
}
