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
import app.markiro.handheld.core.storage.BoxRegistryEntity
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MembershipStatus
import app.markiro.handheld.core.storage.PalletEntity
import app.markiro.handheld.core.storage.PalletKind
import app.markiro.handheld.core.storage.PalletMembershipEntity
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import app.markiro.handheld.feature.signin.SessionHolder
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The pallet-disassemble flow, on both of its routes.
 *
 * The shift-scoped route is the exceptions hub's; the shift-less one belongs to
 * the «Паллеты» mode, where a warehouse pallet has no shift to scope by.
 */
@RunWith(AndroidJUnit4::class)
class PalletDisassembleViewModelTest {
    @get:Rule
    val main = MainDispatcherRule()

    private lateinit var db: HandheldDatabase
    private val scans = MutableSharedFlow<ScanEvent>(extraBufferCapacity = 4)
    private val session = SessionHolder().apply {
        signIn(OperatorRecord("op-1", "Иванова Анна", "4127", "operator", "x", null, true))
    }
    private val warehouseSscc = "346006820000000014"
    private val productionSscc = "346006820000000021"
    private val boxSscc = "346006820000000038"

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

    private suspend fun warehousePallet(
        palletId: String = "p1",
        sscc: String? = warehouseSscc,
        closedAt: String? = "2026-09-11T08:00:00.000Z",
        members: Int = 2,
    ) {
        db.palletDao().insert(
            PalletEntity(
                palletId = palletId, shiftId = null, terminalId = "dev-1", sscc = sscc,
                openedAt = "2026-09-11T07:00:00.000Z", closedAt = closedAt, operatorId = "op-1",
                printState = "printed", printReason = null, ackedAt = null,
                kind = PalletKind.WAREHOUSE, productId = "prod-1", deviceId = "dev-1",
            ),
        )
        repeat(members) { n ->
            val member = "member-$palletId-$n"
            db.boxRegistryDao().upsert(
                BoxRegistryEntity(
                    sscc = member, boxId = "box-$n", productId = "prod-1", bottleCount = 12,
                    contentKeysJson = "[]", updatedAt = "2026-09-11T07:10:00.000Z", localPalletId = palletId,
                ),
            )
            db.palletMembershipDao().insert(
                PalletMembershipEntity(
                    palletId = palletId, sscc = member, addedAt = "2026-09-11T07:2$n:00.000Z",
                    operatorId = "op-1", status = MembershipStatus.ACCEPTED, reason = null,
                    winningPalletSscc = null, ackedAt = null, acknowledgedAt = null, bottleCount = 12,
                ),
            )
        }
    }

    private suspend fun productionPallet(palletId: String = "p2", shiftId: String = "s1", boxes: Int = 3) {
        db.palletDao().insert(
            PalletEntity(
                palletId = palletId, shiftId = shiftId, terminalId = "dev-1", sscc = productionSscc,
                openedAt = "2026-09-11T07:00:00.000Z", closedAt = "2026-09-11T08:00:00.000Z",
                operatorId = "op-1", printState = "printed", printReason = null, ackedAt = null,
            ),
        )
        repeat(boxes) { n ->
            db.boxDao().insert(
                BoxEntity(
                    boxId = "$palletId-box-$n", shiftId = shiftId, sscc = null,
                    openedAt = "2026-09-11T07:0$n:00.000Z", closedAt = "2026-09-11T07:3$n:00.000Z",
                    operatorId = "op-1", printState = "printed", printReason = null, ackedAt = null,
                    palletId = palletId,
                ),
            )
        }
    }

    /** The mode's route carries no `shiftId` at all; the hub's carries one. */
    private fun vm(shiftId: String? = null) = main.track(
        PalletDisassembleViewModel(
            db, ExceptionEngine(db), session, ScanRouterAdapter(scans),
            if (shiftId == null) SavedStateHandle() else SavedStateHandle(mapOf("shiftId" to shiftId)),
        ),
    )

    /** Waits for the view model's own collector: a scan with no subscriber is dropped. */
    private suspend fun scan(raw: String) {
        scans.subscriptionCount.first { it > 0 }
        scans.emit(ScanEvent(raw, null, "debug", 0))
    }

    private suspend fun refusedMessage(vm: PalletDisassembleViewModel): Int =
        (vm.step.first { it is PalletDisassembleStep.Refused } as PalletDisassembleStep.Refused).message

    @Test
    fun aBoxLabelIsRefused() = runTest {
        warehousePallet()
        db.boxRegistryDao().upsert(
            BoxRegistryEntity(
                sscc = boxSscc, boxId = "box-9", productId = "prod-1", bottleCount = 12,
                contentKeysJson = "[]", updatedAt = "2026-09-11T07:10:00.000Z",
            ),
        )
        val vm = vm()
        vm.step.first { it is PalletDisassembleStep.ScanPallet }
        scan("(00)$boxSscc")
        assertEquals(R.string.pallet_disassemble_unknown, refusedMessage(vm))
    }

    @Test
    fun anOpenPalletIsRefused() = runTest {
        // A pallet that already carries its number but is not closed: the
        // number is what the operator scans, so the refusal has to name the
        // real cause rather than «это не паллета».
        warehousePallet(closedAt = null)
        val vm = vm()
        vm.step.first { it is PalletDisassembleStep.ScanPallet }
        scan("(00)$warehouseSscc")
        assertEquals(R.string.pallet_disassemble_not_closed, refusedMessage(vm))
    }

    @Test
    fun aClosedWarehousePalletIsRetiredAndItsClaimsReleased() = runTest {
        warehousePallet(members = 2)
        val vm = vm()
        vm.step.first { it is PalletDisassembleStep.ScanPallet }
        scan("(00)$warehouseSscc")
        val reason = vm.step.first { it is PalletDisassembleStep.Reason } as PalletDisassembleStep.Reason
        assertEquals("p1", reason.palletId)
        assertEquals(warehouseSscc, reason.sscc)
        assertEquals(2, reason.boxCount)

        vm.chooseReason(DisassembleReason.DAMAGED_PACKAGE)
        val confirm = vm.step.first { it is PalletDisassembleStep.Confirm } as PalletDisassembleStep.Confirm
        assertEquals(2, confirm.boxCount)
        // Nothing is applied before the third step.
        assertNull(db.palletDao().get("p1")?.disassembledAt)

        vm.confirm()
        vm.step.first { it is PalletDisassembleStep.Retired }
        assertNotNull(db.palletDao().get("p1")?.disassembledAt)
        assertEquals(emptyList<BoxRegistryEntity>(), db.boxRegistryDao().claimed())
        // Membership rows are history and stay behind.
        assertEquals(2, db.palletMembershipDao().byPallet("p1").size)

        val queued = db.palletExceptionDao().queued().single()
        assertEquals("disassemble", queued.kind)
        assertEquals(DisassembleReason.DAMAGED_PACKAGE.audit, queued.reason)
        assertEquals(JsonNull, Json.parseToJsonElement(queued.payloadJson).jsonObject.getValue("shiftId"))
    }

    @Test
    fun aProductionPalletOfTheRouteShiftIsRetiredWithItsShift() = runTest {
        productionPallet(shiftId = "s1", boxes = 3)
        val vm = vm(shiftId = "s1")
        vm.step.first { it is PalletDisassembleStep.ScanPallet }
        scan("(00)$productionSscc")
        val reason = vm.step.first { it is PalletDisassembleStep.Reason } as PalletDisassembleStep.Reason
        assertEquals(3, reason.boxCount)
        vm.chooseReason(DisassembleReason.WRONG_PRODUCT)
        vm.step.first { it is PalletDisassembleStep.Confirm }
        vm.confirm()
        vm.step.first { it is PalletDisassembleStep.Retired }
        assertEquals("s1", db.palletExceptionDao().queued().single().shiftId)
    }

    /** The hub belongs to one shift, so a pallet of another one is not its business. */
    @Test
    fun theShiftRouteRefusesAPalletOfAnotherShift() = runTest {
        productionPallet(shiftId = "s2")
        val vm = vm(shiftId = "s1")
        vm.step.first { it is PalletDisassembleStep.ScanPallet }
        scan("(00)$productionSscc")
        assertEquals(R.string.pallet_disassemble_unknown, refusedMessage(vm))
        assertEquals(0, db.palletExceptionDao().queued().size)
    }

    @Test
    fun scanningAnAlreadyRetiredPalletIsRefused() = runTest {
        warehousePallet()
        val vm = vm()
        vm.step.first { it is PalletDisassembleStep.ScanPallet }
        scan("(00)$warehouseSscc")
        vm.step.first { it is PalletDisassembleStep.Reason }
        vm.chooseReason(DisassembleReason.WRONG_QUANTITY)
        vm.step.first { it is PalletDisassembleStep.Confirm }
        vm.confirm()
        vm.step.first { it is PalletDisassembleStep.Retired }

        vm.cancel()
        vm.step.first { it is PalletDisassembleStep.ScanPallet }
        scan("(00)$warehouseSscc")
        assertEquals(R.string.pallet_disassemble_already, refusedMessage(vm))
        // The second pass queued nothing: one physical event, one fact.
        assertEquals(1, db.palletExceptionDao().queued().size)
    }
}
