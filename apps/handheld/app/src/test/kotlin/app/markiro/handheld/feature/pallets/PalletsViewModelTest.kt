package app.markiro.handheld.feature.pallets

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.MainDispatcherRule
import app.markiro.handheld.core.auth.OperatorRecord
import app.markiro.handheld.core.box.ClosePalletResult
import app.markiro.handheld.core.box.PrintOutcome
import app.markiro.handheld.core.box.PrintReason
import app.markiro.handheld.core.exceptions.ReprintReason
import app.markiro.handheld.core.pallets.AttachResult
import app.markiro.handheld.core.print.PrinterEntity
import app.markiro.handheld.core.scan.ScanEvent
import app.markiro.handheld.core.scan.ScanRouterAdapter
import app.markiro.handheld.core.signal.SignalKind
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MembershipStatus
import app.markiro.handheld.core.storage.PalletEntity
import app.markiro.handheld.core.storage.PalletKind
import app.markiro.handheld.core.storage.PalletMembershipEntity
import app.markiro.handheld.core.storage.PalletPrint
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import app.markiro.handheld.core.writeoff.MirrorOutcome
import app.markiro.handheld.feature.signin.SessionHolder
import app.markiro.handheld.feature.work.PalletCloseStep
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The pallet mode's state machine, without Room behind the gateway.
 *
 * Every refusal is asserted by verdict AND by signal: a warehouse operator
 * usually hears the answer before reading it, so a refusal that plays `OK`
 * would be a silent wrong accept on the floor.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
class PalletsViewModelTest {
    @get:Rule
    val main = MainDispatcherRule()

    private lateinit var db: HandheldDatabase
    private val scans = MutableSharedFlow<ScanEvent>(extraBufferCapacity = 16)
    private val signals = mutableListOf<SignalKind>()
    private val session = SessionHolder().apply {
        signIn(OperatorRecord("op-1", "Иванова Анна", "4127", "operator", "x", null, true))
    }
    private val gateway = FakeGateway()

    private val openPallet = PalletEntity(
        palletId = "w1", shiftId = null, terminalId = "dev-1", sscc = null, openedAt = "t", closedAt = null,
        operatorId = "op-1", printState = PalletPrint.PENDING, printReason = null, ackedAt = null,
        kind = PalletKind.WAREHOUSE, productId = "p1", deviceId = "dev-1",
    )

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        db.initializeRecoveryForTest()
        gateway.open.value = openPallet
    }

    @After
    fun tearDown() {
        try {
            main.cancelAndJoinModels()
        } finally {
            db.close()
        }
    }

    private class FakeGateway : PalletsGateway {
        var permission: Boolean? = true
        var ready: Boolean = true
        var next: AttachResult = AttachResult.UnknownBox
        var closeResult: ClosePalletResult = ClosePalletResult.Empty
        var printOutcome: PrintOutcome = PrintOutcome.Printed

        /** Every print attempt in order: the pallet, the replacement printer, the unknown-retry flag, the reprint flag. */
        val prints = mutableListOf<Print>()

        /** Held open, this keeps a print in flight so «Back» can be tested against it. */
        var printGate: CompletableDeferred<Unit>? = null

        /** Makes `close` throw rather than answer, the way a revoked lease does. */
        var closeThrows: (() -> Throwable)? = null

        /** Makes `attach` throw rather than answer, the way a revoked lease does. */
        var attachThrows: (() -> Throwable)? = null
        var attachCalls = 0
        var closeCalls = 0
        var removed: Pair<String, String>? = null
        var acknowledged: String? = null
        val reprintReasons = mutableListOf<ReprintReason>()
        val pallets = mutableMapOf<String, PalletEntity>()
        var nudges = 0
        var refreshes = 0
        var resolved: String? = null
        var deferred: String? = null
        var reprints = 0
        val open = MutableStateFlow<PalletEntity?>(null)
        val closedPalletCount = MutableStateFlow(0)
        val members = MutableStateFlow<List<PalletMembershipEntity>>(emptyList())
        val rejections = MutableStateFlow<List<PalletMembershipEntity>>(emptyList())

        override suspend fun canBuildPallets(operatorId: String): Boolean? = permission

        override suspend fun bootstrapReady(): Boolean = ready

        override val stampAt: Flow<Long?> = MutableStateFlow(1_757_845_320_000L)

        override suspend fun refresh(): MirrorOutcome {
            refreshes++
            return MirrorOutcome.Ok
        }

        override fun observeOpen(): Flow<PalletEntity?> = open

        override fun observeClosedPalletCount(): Flow<Int> = closedPalletCount

        override fun observePrinters(): Flow<List<PrinterEntity>> = MutableStateFlow(emptyList())

        override fun observeMembers(palletId: String): Flow<List<PalletMembershipEntity>> = members

        override fun observeRejections(): Flow<List<PalletMembershipEntity>> = rejections

        override suspend fun capacity(pallet: PalletEntity): Int? = 12

        override suspend fun pallet(palletId: String): PalletEntity? = pallets[palletId]

        override suspend fun countOnPallet(palletId: String): Int = 5

        override suspend fun productName(productId: String): String? = "Вода 0,5 л"

        override suspend fun attach(sscc: String, operatorId: String?): AttachResult {
            attachCalls++
            attachThrows?.let { throw it() }
            return next
        }

        override suspend fun remove(palletId: String, sscc: String): Boolean {
            removed = palletId to sscc
            return true
        }

        override suspend fun close(operatorId: String?): ClosePalletResult {
            closeCalls++
            closeThrows?.let { throw it() }
            return closeResult
        }

        override suspend fun acknowledge(palletId: String) {
            acknowledged = palletId
        }

        override suspend fun print(
            palletId: String,
            replacementPrinterId: String?,
            allowUnknown: Boolean,
            reprint: Boolean,
        ): PrintOutcome {
            prints += Print(palletId, replacementPrinterId, allowUnknown, reprint)
            printGate?.await()
            return printOutcome
        }

        override suspend fun resolveUnknownAsPrinted(palletId: String) {
            resolved = palletId
        }

        override suspend fun defer(palletId: String) {
            deferred = palletId
        }

        override suspend fun reprintPallet(palletId: String, reason: ReprintReason, operatorId: String?, deviceId: String?) {
            reprints++
            reprintReasons += reason
        }

        override suspend fun deviceId(): String? = "dev-1"

        override fun nudgeSync() {
            nudges++
        }
    }

    private fun vm() = main.track(
        PalletsViewModel(gateway, session, ScanRouterAdapter(scans), db.recovery) { signals += it },
    )

    /** One print attempt as the gateway saw it. */
    private data class Print(val palletId: String, val printerId: String?, val allowUnknown: Boolean, val reprint: Boolean)

    private fun rejection(sscc: String, reason: String, winner: String?, palletId: String = "w1") = PalletMembershipEntity(
        palletId = palletId, sscc = sscc, addedAt = "t", operatorId = null, status = MembershipStatus.REJECTED,
        reason = reason, winningPalletSscc = winner, ackedAt = "t", acknowledgedAt = null,
    )

    /** A pallet this device already closed and labelled. */
    private val closedPallet = openPallet.copy(
        palletId = "w0", sscc = "134600682000000011", closedAt = "t", printState = PalletPrint.PRINTED,
    )

    @Test
    fun anOperatorWithoutPermissionIsBlockedBeforeTheFirstScan() = runTest {
        gateway.permission = false
        val vm = vm()
        advanceUntilIdle()
        assertEquals(PalletsBlocked.NO_PERMISSION, vm.state.value.blocked)
        scans.emit(ScanEvent("034600682000000014", null, "wedge", 0))
        advanceUntilIdle()
        assertEquals(0, gateway.attachCalls)
    }

    @Test
    fun aDeviceThatNeverSyncedIsBlockedToo() = runTest {
        gateway.ready = false
        val vm = vm()
        advanceUntilIdle()
        assertEquals(PalletsBlocked.NEVER_SYNCED, vm.state.value.blocked)
    }

    @Test
    fun aUnitCodeIsRefusedSoftlyAndNeverRecorded() = runTest {
        val vm = vm()
        advanceUntilIdle()
        scans.emit(ScanEvent("0104600682000013215S", null, "wedge", 0))
        advanceUntilIdle()
        assertEquals(PalletVerdict.UnitCode, vm.state.value.lastVerdict)
        assertEquals(listOf(SignalKind.ERROR), signals)
        assertEquals(0, gateway.attachCalls)
    }

    @Test
    fun anAcceptedScanUpdatesTheStripAndPlaysOk() = runTest {
        gateway.next = AttachResult.Attached(openPallet, 1, 12, false)
        val vm = vm()
        advanceUntilIdle()
        scans.emit(ScanEvent("034600682000000014", null, "wedge", 0))
        advanceUntilIdle()
        assertEquals(PalletVerdict.Attached("000014"), vm.state.value.lastVerdict)
        assertEquals(listOf(SignalKind.OK), signals)
    }

    @Test
    fun capacityClosesAndPrintsThroughTheCloseStep() = runTest {
        gateway.next = AttachResult.Attached(openPallet, 12, 12, true)
        gateway.closeResult = ClosePalletResult.Closed(
            openPallet.copy(sscc = "134600682000000011", closedAt = "t"), "134600682000000011", 12, "t",
        )
        gateway.printOutcome = PrintOutcome.Printed
        val vm = vm()
        advanceUntilIdle()
        scans.emit(ScanEvent("034600682000000014", null, "wedge", 0))
        advanceUntilIdle()
        assertTrue(vm.state.value.closeStep is PalletCloseStep.Printed)
        assertTrue(SignalKind.BOX_DONE in signals)
        assertEquals(1, gateway.nudges)
        // The automatic first label goes to the assigned printer and is NOT
        // allowed to resolve an unknown outcome on its own: only a person who
        // looked at the printer may say a label with an unknown fate was fine.
        assertEquals(listOf(Print("w1", null, allowUnknown = false, reprint = false)), gateway.prints)
        // The pallet this verdict named is closed; its banner must not survive.
        assertNull(vm.state.value.lastVerdict)
    }

    @Test
    fun refusalsMapToVerdictsAndErrorSignals() = runTest {
        gateway.next = AttachResult.OnAnotherPallet("134600682000000011")
        val vm = vm()
        advanceUntilIdle()
        scans.emit(ScanEvent("034600682000000014", null, "wedge", 0))
        advanceUntilIdle()
        assertEquals(PalletVerdict.OnPallet("000011"), vm.state.value.lastVerdict)
        assertEquals(listOf(SignalKind.ERROR), signals)
    }

    /** A soft duplicate is not an error: the box is already where the operator wanted it. */
    @Test
    fun theSameBoxTwiceIsADuplicateNotAnError() = runTest {
        gateway.next = AttachResult.AlreadyOnThisPallet
        val vm = vm()
        advanceUntilIdle()
        scans.emit(ScanEvent("034600682000000014", null, "wedge", 0))
        advanceUntilIdle()
        assertEquals(PalletVerdict.AlreadyHere("000014"), vm.state.value.lastVerdict)
        assertEquals(listOf(SignalKind.DUPLICATE), signals)
    }

    @Test
    fun aRejectionFromTheServerShowsUntilAcknowledged() = runTest {
        gateway.rejections.value = listOf(rejection("034600682000000014", "already_on_pallet", "00134600682000000099"))
        val vm = vm()
        advanceUntilIdle()
        assertEquals(1, vm.state.value.rejections.size)
        vm.acknowledge("w1")
        advanceUntilIdle()
        assertEquals("w1", gateway.acknowledged)
    }

    /** A rejected row is not on the pallet, so it must not be counted as one of its boxes. */
    /**
     * The case that made the label lie: a membership is still pending when the
     * operator closes the pallet and prints it, and the rejection lands after.
     * Scoped to the open pallet, that news arrived only while that pallet was
     * open -- which it no longer is -- so the paper on the stack kept claiming
     * a box that is recorded somewhere else, with nothing on screen to say so.
     */
    @Test
    fun aRejectionOnAClosedPalletIsShownWithNoPalletOpen() = runTest {
        gateway.open.value = null
        gateway.pallets["w0"] = closedPallet
        gateway.rejections.value = listOf(rejection("034600682000000014", "already_on_pallet", null, palletId = "w0"))
        val vm = vm()
        advanceUntilIdle()
        assertNull(vm.state.value.pallet)
        assertEquals(1, vm.state.value.rejections.size)
        assertEquals("w0", vm.state.value.rejections.single().palletId)
        assertEquals(closedPallet, vm.state.value.rejectionPallets["w0"])
        // «Принято» names the pallet now: the old open-pallet-only form had
        // nothing to acknowledge here at all.
        vm.acknowledge("w0")
        advanceUntilIdle()
        assertEquals("w0", gateway.acknowledged)
    }

    /**
     * The replacement label. It is a real second label in the warehouse, so the
     * reprint exception is queued BEFORE the print goes out, and it carries the
     * reason that is actually true: the pallet's contents changed.
     */
    @Test
    fun reprintingAClosedPalletQueuesTheFactAndDrivesThePrintStep() = runTest {
        gateway.open.value = null
        gateway.pallets["w0"] = closedPallet
        gateway.rejections.value = listOf(rejection("034600682000000014", "already_on_pallet", null, palletId = "w0"))
        gateway.printOutcome = PrintOutcome.Printed
        val vm = vm()
        advanceUntilIdle()
        vm.reprint("w0")
        advanceUntilIdle()
        assertEquals(1, gateway.reprints)
        assertEquals(listOf(ReprintReason.PALLET_CONTENTS_CHANGED), gateway.reprintReasons)
        // `reprint = true` is what lets `PalletPrinter` print a pallet whose
        // state is already `printed`; without it the second label never leaves.
        assertEquals(listOf(Print("w0", null, allowUnknown = true, reprint = true)), gateway.prints)
        val step = vm.state.value.closeStep
        assertTrue(step is PalletCloseStep.Printed)
        // The count on the replacement label is the pallet's CURRENT one.
        assertEquals("134600682000000011", (step as PalletCloseStep.Printed).pallet.sscc)
        assertEquals(5, step.pallet.boxCount)
    }

    /** Nothing is reprinted for a pallet that was never printed. */
    @Test
    fun anOpenPalletHasNoLabelToReprint() = runTest {
        gateway.pallets["w1"] = openPallet
        gateway.rejections.value = listOf(rejection("034600682000000014", "not_found", null))
        val vm = vm()
        advanceUntilIdle()
        vm.reprint("w1")
        advanceUntilIdle()
        assertEquals(0, gateway.reprints)
        assertTrue(gateway.prints.isEmpty())
        assertEquals(PalletCloseStep.Idle, vm.state.value.closeStep)
    }

    /**
     * A check that THREW is not «короб неизвестен»: that diagnosis sends the
     * operator to refresh a registry that was never the problem. Same reasoning
     * -- and the same `RecoveryBlocked`-before-`CancellationException` order --
     * as the close path.
     */
    @Test
    fun aThrownAttachIsUnavailableNotAnUnknownBox() = runTest {
        gateway.attachThrows = { app.markiro.handheld.core.storage.RecoveryBlocked() }
        val vm = vm()
        advanceUntilIdle()
        scans.emit(ScanEvent("034600682000000014", null, "wedge", 0))
        advanceUntilIdle()
        assertEquals(PalletVerdict.Unavailable, vm.state.value.lastVerdict)
        assertEquals(listOf(SignalKind.ERROR), signals)
    }

    /** An unpaired device answers `Unavailable` rather than blaming the box. */
    @Test
    fun anUnpairedDeviceIsUnavailableNotAnUnknownBox() = runTest {
        gateway.next = AttachResult.Unavailable
        val vm = vm()
        advanceUntilIdle()
        scans.emit(ScanEvent("034600682000000014", null, "wedge", 0))
        advanceUntilIdle()
        assertEquals(PalletVerdict.Unavailable, vm.state.value.lastVerdict)
        assertEquals(listOf(SignalKind.ERROR), signals)
    }

    @Test
    fun rejectedRowsAreNotCountedAsMembers() = runTest {
        gateway.members.value = listOf(
            PalletMembershipEntity("w1", "034600682000000014", "t", null, MembershipStatus.PENDING, null, null, null, null),
            rejection("034600682000000021", "not_found", null),
        )
        val vm = vm()
        advanceUntilIdle()
        assertEquals(1, vm.state.value.boxCount)
        assertEquals(1, vm.state.value.members.size)
        assertEquals(12, vm.state.value.capacity)
        assertEquals("Вода 0,5 л", vm.state.value.productName)
    }

    @Test
    fun earlyCloseAsksFirst() = runTest {
        gateway.open.value = openPallet
        val vm = vm()
        advanceUntilIdle()
        vm.requestEarlyClose()
        assertTrue(vm.state.value.confirmEarlyClose)
        vm.confirmEarlyClose()
        advanceUntilIdle()
        assertEquals(1, gateway.closeCalls)
    }

    @Test
    fun aRefusedCloseIsShownNotSwallowed() = runTest {
        gateway.open.value = openPallet
        gateway.closeResult = ClosePalletResult.NoSerials
        val vm = vm()
        advanceUntilIdle()
        vm.requestEarlyClose()
        vm.confirmEarlyClose()
        advanceUntilIdle()
        assertEquals(PalletCloseStep.Refused(ClosePalletResult.NoSerials), vm.state.value.closeStep)
    }

    /** An unknown print outcome is resolved by a person; a retry first queues the reprint exception. */
    @Test
    fun anUnknownPrintIsRetriedOnlyOnPurpose() = runTest {
        gateway.open.value = openPallet
        gateway.closeResult = ClosePalletResult.Closed(
            openPallet.copy(sscc = "134600682000000011", closedAt = "t"), "134600682000000011", 3, "t",
        )
        gateway.printOutcome = PrintOutcome.Unknown("interrupted")
        val vm = vm()
        advanceUntilIdle()
        vm.requestEarlyClose()
        vm.confirmEarlyClose()
        advanceUntilIdle()
        assertTrue(vm.state.value.closeStep is PalletCloseStep.Unknown)
        gateway.printOutcome = PrintOutcome.Printed
        vm.retryPrint()
        advanceUntilIdle()
        assertEquals(1, gateway.reprints)
        assertTrue(vm.state.value.closeStep is PalletCloseStep.Printed)
        // The first attempt refused to resolve an unknown outcome; the operator's
        // own retry is the one that carries `allowUnknown`.
        assertEquals(
            listOf(Print("w1", null, allowUnknown = false, reprint = false), Print("w1", null, allowUnknown = true, reprint = false)),
            gateway.prints,
        )
    }

    /**
     * A dead printer must not strand a closed pallet: the profile the operator
     * picked has to reach the gateway, or the retry goes to the same dead one.
     */
    @Test
    fun aRetryOnAnotherPrinterCarriesThatProfile() = runTest {
        gateway.closeResult = ClosePalletResult.Closed(
            openPallet.copy(sscc = "134600682000000011", closedAt = "t"), "134600682000000011", 3, "t",
        )
        gateway.printOutcome = PrintOutcome.Failed(PrintReason.NO_PAPER)
        val vm = vm()
        advanceUntilIdle()
        vm.requestEarlyClose()
        vm.confirmEarlyClose()
        advanceUntilIdle()
        assertTrue(vm.state.value.closeStep is PalletCloseStep.Failed)
        gateway.printOutcome = PrintOutcome.Printed
        vm.retryPrint("printer-2")
        advanceUntilIdle()
        assertEquals(Print("w1", "printer-2", allowUnknown = true, reprint = false), gateway.prints.last())
        assertTrue(vm.state.value.closeStep is PalletCloseStep.Printed)
        // A failed print is not an unknown one, so no reprint exception is owed.
        assertEquals(0, gateway.reprints)
    }

    /**
     * A closing that THREW is not an empty pallet.
     *
     * `RecoveryBlocked` is a `CancellationException` by type, so the naive
     * catch would either swallow it into «в паллете нет коробов» or let it kill
     * the coroutine silently. Both send the operator looking for boxes that are
     * already on the pallet.
     */
    @Test
    fun aThrownCloseIsReportedAsUnavailableNotEmpty() = runTest {
        gateway.closeThrows = { app.markiro.handheld.core.storage.RecoveryBlocked() }
        val vm = vm()
        advanceUntilIdle()
        vm.requestEarlyClose()
        vm.confirmEarlyClose()
        advanceUntilIdle()
        assertEquals(PalletCloseStep.Refused(ClosePalletResult.Unavailable), vm.state.value.closeStep)
    }

    /** The same for a plain failure, which is not a cancellation at all. */
    @Test
    fun aDatabaseFailureDuringCloseIsUnavailableToo() = runTest {
        gateway.closeThrows = { IllegalStateException("disk") }
        val vm = vm()
        advanceUntilIdle()
        vm.requestEarlyClose()
        vm.confirmEarlyClose()
        advanceUntilIdle()
        assertEquals(PalletCloseStep.Refused(ClosePalletResult.Unavailable), vm.state.value.closeStep)
    }

    /**
     * Back during a print in flight must not clear the screen: the close is
     * still running and would put its own outcome straight back, and in the gap
     * a scan would attach a box to a pallet that is already closed.
     */
    @Test
    fun aPrintInFlightIsNotDismissable() = runTest {
        val gate = CompletableDeferred<Unit>()
        gateway.printGate = gate
        gateway.closeResult = ClosePalletResult.Closed(
            openPallet.copy(sscc = "134600682000000011", closedAt = "t"), "134600682000000011", 3, "t",
        )
        val vm = vm()
        advanceUntilIdle()
        vm.requestEarlyClose()
        vm.confirmEarlyClose()
        advanceUntilIdle()
        assertTrue(vm.state.value.closeStep is PalletCloseStep.Printing)
        vm.dismissClose()
        assertTrue(vm.state.value.closeStep is PalletCloseStep.Printing)
        gate.complete(Unit)
        advanceUntilIdle()
        assertTrue(vm.state.value.closeStep is PalletCloseStep.Printed)
    }

    @Test
    fun aDeferredLabelLeavesTheCloseStepAndRemembersThePallet() = runTest {
        gateway.open.value = openPallet
        gateway.closeResult = ClosePalletResult.Closed(
            openPallet.copy(sscc = "134600682000000011", closedAt = "t"), "134600682000000011", 3, "t",
        )
        gateway.printOutcome = PrintOutcome.Failed(PrintReason.NO_PAPER)
        val vm = vm()
        advanceUntilIdle()
        vm.requestEarlyClose()
        vm.confirmEarlyClose()
        advanceUntilIdle()
        assertTrue(vm.state.value.closeStep is PalletCloseStep.Failed)
        vm.deferLabel()
        advanceUntilIdle()
        assertEquals("w1", gateway.deferred)
        assertEquals(PalletCloseStep.Idle, vm.state.value.closeStep)
    }

    @Test
    fun removingABoxGoesThroughTheGateway() = runTest {
        val vm = vm()
        advanceUntilIdle()
        vm.remove("034600682000000014")
        advanceUntilIdle()
        assertEquals("w1" to "034600682000000014", gateway.removed)
    }

    /** No scan is judged while a closed pallet's label is still on screen. */
    @Test
    fun scansAreIgnoredWhileTheCloseStepHoldsTheScreen() = runTest {
        gateway.open.value = openPallet
        gateway.closeResult = ClosePalletResult.NoSerials
        val vm = vm()
        advanceUntilIdle()
        vm.requestEarlyClose()
        vm.confirmEarlyClose()
        advanceUntilIdle()
        scans.emit(ScanEvent("034600682000000014", null, "wedge", 0))
        advanceUntilIdle()
        assertEquals(0, gateway.attachCalls)
    }

    /**
     * `setScanning(false)` is what lets `Routes.PALLETS` stop reading a scan while
     * the pallet-disassemble route sits on top of it — otherwise the label
     * scanned there would ALSO reach this mode and be refused as «это паллета».
     * A scan while off must produce no verdict and never call the gateway;
     * turning it back on must let the next scan through as usual.
     */
    @Test
    fun scanningOffStopsScansAndScanningOnResumesThem() = runTest {
        gateway.next = AttachResult.Attached(openPallet, 1, 12, false)
        val vm = vm()
        advanceUntilIdle()
        vm.setScanning(false)
        scans.emit(ScanEvent("034600682000000014", null, "wedge", 0))
        advanceUntilIdle()
        assertNull(vm.state.value.lastVerdict)
        assertEquals(0, gateway.attachCalls)
        vm.setScanning(true)
        scans.emit(ScanEvent("034600682000000014", null, "wedge", 0))
        advanceUntilIdle()
        assertEquals(PalletVerdict.Attached("000014"), vm.state.value.lastVerdict)
        assertEquals(1, gateway.attachCalls)
    }
}
