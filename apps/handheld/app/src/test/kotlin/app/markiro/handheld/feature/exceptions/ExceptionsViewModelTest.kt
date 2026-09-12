package app.markiro.handheld.feature.exceptions

import app.markiro.handheld.core.storage.initializeRecoveryForTest
import androidx.lifecycle.SavedStateHandle
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.MainDispatcherRule
import app.markiro.handheld.R
import app.markiro.handheld.core.auth.OperatorRecord
import app.markiro.handheld.core.exceptions.ExceptionEngine
import app.markiro.handheld.core.storage.BoxEntity
import app.markiro.handheld.core.storage.CodeEntity
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.feature.signin.SessionHolder
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ExceptionsViewModelTest {
    @get:Rule
    val main = MainDispatcherRule()

    private lateinit var db: HandheldDatabase
    private val session = SessionHolder().apply {
        signIn(OperatorRecord("op-1", "Иванова Анна", "4127", "operator", "x", null, true))
    }
    private val a = "a".repeat(64)
    private val b = "b".repeat(64)

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
        db.initializeRecoveryForTest()
    }

    @After
    fun tearDown() {
        try {
            main.cancelAndJoinModels()
        } finally {
            db.close()
        }
    }

    private suspend fun openBox() = db.boxDao().insert(
        BoxEntity(
            boxId = "box-1", shiftId = "s1", sscc = null, openedAt = "2026-09-11T07:00:00.000Z",
            closedAt = null, operatorId = "op-1", printState = "pending", printReason = null, ackedAt = null,
        ),
    )

    private suspend fun scan(hash: String, at: String) =
        db.codeDao().insert(CodeEntity(hash, "s1", "04600000000015", hash.take(6), at, "box-1"))

    private fun vm() = main.track(
        ExceptionsViewModel(db, ExceptionEngine(db), session, SavedStateHandle(mapOf("shiftId" to "s1"))),
    )

    /** The list names the undo target, because that is what the operator confirms against. */
    @Test
    fun theListNamesTheLastScan() = runTest {
        openBox()
        scan(a, "2026-09-11T07:59:00.000Z")
        val ui = vm().state.first { it.undoTarget != null }
        assertEquals(a.takeLast(6).uppercase(), ui.undoTarget!!.codeTail)
        assertTrue(ui.canUndo)
    }

    /** Validation mode has no box, so there is nothing to undo or clear. */
    @Test
    fun withNoOpenBoxNothingIsUndoableOrClearable() = runTest {
        val ui = vm().state.first { !it.canUndo }
        assertNull(ui.openBoxId)
        assertEquals(0, ui.openBoxCount)
        assertNull(ui.undoTarget)
    }

    /** An open box with no scans yet: the row is there, the action is not. */
    @Test
    fun anEmptyBoxHasNothingToUndo() = runTest {
        openBox()
        val ui = vm().state.first { it.openBoxId != null }
        assertFalse(ui.canUndo)
        assertNull(ui.undoTarget)
    }

    @Test
    fun confirmingUndoReleasesTheCodeAndReportsIt() = runTest {
        openBox()
        scan(a, "2026-09-11T07:59:00.000Z")
        val vm = vm()
        vm.state.first { it.undoTarget != null }
        vm.startUndo()
        vm.state.first { it.step is ExceptionsStep.ConfirmUndo }
        vm.confirm()
        assertEquals(
            R.string.exceptions_undone,
            (vm.state.first { it.step is ExceptionsStep.Done }.step as ExceptionsStep.Done).message,
        )
        assertNull(db.codeDao().get(a))
        assertEquals(1, db.boxExceptionDao().unackedCount())
    }

    /** A scan landing while the confirmation is open must not silently retarget it. */
    @Test
    fun aScanDuringTheConfirmationRefusesTheUndo() = runTest {
        openBox()
        scan(a, "2026-09-11T07:59:00.000Z")
        val vm = vm()
        vm.state.first { it.undoTarget?.codeHash == a }
        vm.startUndo()
        vm.state.first { it.step is ExceptionsStep.ConfirmUndo }
        scan(b, "2026-09-11T07:59:30.000Z")
        vm.confirm()
        assertEquals(
            R.string.exceptions_undo_stale,
            (vm.state.first { it.step is ExceptionsStep.Refused }.step as ExceptionsStep.Refused).message,
        )
        assertNotNull(db.codeDao().get(a))
        assertNotNull(db.codeDao().get(b))
        assertEquals(0, db.boxExceptionDao().unackedCount())
    }

    @Test
    fun confirmingClearEmptiesTheBox() = runTest {
        openBox()
        scan(a, "2026-09-11T07:59:00.000Z")
        scan(b, "2026-09-11T07:59:30.000Z")
        val vm = vm()
        vm.state.first { it.openBoxCount == 2 }
        vm.startClear()
        vm.state.first { it.step is ExceptionsStep.ConfirmClear }
        vm.confirm()
        assertEquals(
            R.string.exceptions_cleared,
            (vm.state.first { it.step is ExceptionsStep.Done }.step as ExceptionsStep.Done).message,
        )
        assertEquals(0, db.boxDao().itemCount("box-1"))
        assertEquals(1, db.boxExceptionDao().unackedCount())
    }

    /** Backing out of a confirmation applies nothing. */
    @Test
    fun dismissingAConfirmationChangesNothing() = runTest {
        openBox()
        scan(a, "2026-09-11T07:59:00.000Z")
        val vm = vm()
        vm.state.first { it.undoTarget != null }
        vm.startUndo()
        vm.state.first { it.step is ExceptionsStep.ConfirmUndo }
        vm.dismiss()
        vm.state.first { it.step is ExceptionsStep.List }
        assertNotNull(db.codeDao().get(a))
        assertEquals(0, db.boxExceptionDao().unackedCount())
    }

    /** The reprint row needs something to reprint. */
    @Test
    fun withNoClosedBoxesTheReprintCountIsZero() = runTest {
        openBox()
        assertEquals(0, vm().state.first { it.openBoxId != null }.reprintableCount)
    }
}
