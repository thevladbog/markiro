package app.markiro.handheld.feature.writeoff

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.MainDispatcherRule
import app.markiro.handheld.core.auth.OperatorRecord
import app.markiro.handheld.core.km.KmCodec
import app.markiro.handheld.core.scan.ScanEvent
import app.markiro.handheld.core.scan.ScanRouterAdapter
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.WriteoffBoxEntity
import app.markiro.handheld.core.storage.WriteoffOutboxEntity
import app.markiro.handheld.core.storage.WriteoffReasonEntity
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import app.markiro.handheld.core.writeoff.MirrorOutcome
import app.markiro.handheld.feature.signin.SessionHolder
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
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

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
class WriteoffViewModelTest {
    @get:Rule
    val main = MainDispatcherRule()

    private lateinit var db: HandheldDatabase
    private val scans = MutableSharedFlow<ScanEvent>(extraBufferCapacity = 8)
    private val session = SessionHolder().apply {
        signIn(OperatorRecord("op-1", "Иванова Анна", "4127", "operator", "x", null, true))
    }

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
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

    private class FakeGateway(
        val products: Map<String, String> = emptyMap(),
        val productsById: Map<String, String> = emptyMap(),
        val boxes: Map<String, WriteoffBoxEntity> = emptyMap(),
        val permitted: Boolean? = true,
        val ready: Boolean = true,
        reasons: List<WriteoffReasonEntity> = listOf(REASON),
    ) : WriteoffGateway {
        val filed = mutableListOf<Triple<String, WriteoffReasonEntity, List<WriteoffLine>>>()
        private val reasonFlow = MutableStateFlow(reasons)
        private val document = MutableStateFlow<WriteoffOutboxEntity?>(null)
        var refreshes = 0

        override fun observeReasons(): Flow<List<WriteoffReasonEntity>> = reasonFlow

        override suspend fun productName(gtin14: String): String? = products[gtin14]

        override suspend fun productNameById(productId: String): String? = productsById[productId]

        override suspend fun box(sscc: String): WriteoffBoxEntity? = boxes[sscc]

        override suspend fun canWriteoff(operatorId: String): Boolean? = permitted

        override suspend fun catalogueReady(): Boolean = ready

        override val stampAt: Flow<Long?> = MutableStateFlow(1_757_845_320_000L)

        override suspend fun refreshMirror(): MirrorOutcome {
            refreshes++
            return MirrorOutcome.Ok
        }

        override suspend fun file(operatorId: String, reason: WriteoffReasonEntity, lines: List<WriteoffLine>): String {
            filed += Triple(operatorId, reason, lines)
            document.value = WriteoffOutboxEntity(
                documentId = "doc-1", deviceSeq = 1, operatorId = operatorId, reasonId = reason.id, reasonName = reason.name,
                unitCount = lines.count { it is WriteoffLine.Unit }, boxCount = lines.count { it is WriteoffLine.Box },
                requestJson = "{}", createdAt = "t", state = "pending", orderNo = null, acceptedCount = null,
                conflictsJson = null, lastAttemptAt = null,
            )
            return "doc-1"
        }

        override fun observeDocument(id: String): Flow<WriteoffOutboxEntity?> = document

        override fun observeRecent(): Flow<List<WriteoffOutboxEntity>> = MutableStateFlow(emptyList())
    }

    private fun vm(gateway: FakeGateway) = main.track(
        WriteoffViewModel(gateway, session, ScanRouterAdapter(scans), db.recovery) { },
    )

    /** A production-shaped KM: the GS1 group separator ends the variable-length serial. */
    private fun km(serial: String) = "01$GTIN" + "21" + serial + "\u001d" + "93AbCd"

    /**
     * The scan flow has no replay, so a value emitted before the ViewModel's
     * collector starts is simply dropped. Waiting for the subscription makes the
     * test about the state machine rather than about coroutine start order.
     */
    private suspend fun emit(raw: String) {
        scans.subscriptionCount.first { it > 0 }
        scans.emit(ScanEvent(raw, symbology = null, source = "debug", at = 1L))
    }

    @Test
    fun unitScanAddsALineAndNamesTheProduct() = runTest {
        val vm = vm(FakeGateway(products = mapOf(GTIN to "Вода 0,5 л")))
        emit(km("SERIAL01"))
        val ui = vm.state.first { it.unitCount == 1 }
        assertEquals(Verdict.Accepted("RIAL01"), ui.lastVerdict)
        assertEquals("Вода 0,5 л", (ui.lines.single() as WriteoffLine.Unit).name)
    }

    @Test
    fun sameUnitTwiceIsADuplicateNotASecondLine() = runTest {
        val vm = vm(FakeGateway(products = mapOf(GTIN to "Вода 0,5 л")))
        emit(km("SERIAL01"))
        vm.state.first { it.unitCount == 1 }
        emit(km("SERIAL01"))
        val ui = vm.state.first { it.lastVerdict is Verdict.Duplicate }
        assertEquals(1, ui.unitCount)
        assertEquals(1, ui.lines.size)
    }

    @Test
    fun unknownGtinIsRefusedWithoutALine() = runTest {
        val vm = vm(FakeGateway(products = emptyMap()))
        emit(km("SERIAL01"))
        val ui = vm.state.first { it.lastVerdict != null }
        assertEquals(Verdict.UnknownProduct, ui.lastVerdict)
        assertTrue(ui.lines.isEmpty())
    }

    @Test
    fun boxScanAddsABoxLineWithItsCount() = runTest {
        val vm = vm(
            FakeGateway(
                productsById = mapOf("p-1" to "Вода 0,5 л"),
                boxes = mapOf(SSCC to WriteoffBoxEntity(SSCC, "b-1", "p-1", 12, "[]", "t")),
            ),
        )
        emit(SSCC)
        val ui = vm.state.first { it.boxCount == 1 }
        assertEquals(12, ui.unitCount)
        assertEquals("Вода 0,5 л", (ui.lines.single() as WriteoffLine.Box).name)
    }

    @Test
    fun anUnknownBoxIsRefused() = runTest {
        val vm = vm(FakeGateway())
        emit(SSCC)
        assertEquals(Verdict.UnknownBox, vm.state.first { it.lastVerdict != null }.lastVerdict)
    }

    /** Counting a loose unit and then the box that holds it would write it off twice. */
    @Test
    fun unitInsideAnAlreadyListedBoxIsADuplicate() = runTest {
        val key = KmCodec.key(KmCodec.canonicalize(km("SERIAL01")))
        val vm = vm(
            FakeGateway(
                products = mapOf(GTIN to "Вода 0,5 л"),
                productsById = mapOf("p-1" to "Вода 0,5 л"),
                boxes = mapOf(SSCC to WriteoffBoxEntity(SSCC, "b-1", "p-1", 12, """["$key"]""", "t")),
            ),
        )
        emit(km("SERIAL01"))
        vm.state.first { it.unitCount == 1 }
        emit(SSCC)
        val ui = vm.state.first { it.lastVerdict is Verdict.Duplicate }
        assertEquals(0, ui.boxCount)
        assertEquals(1, ui.lines.size)
    }

    @Test
    fun nextIsDisabledWithNoLinesAndConfirmWithoutReason() = runTest {
        val gateway = FakeGateway(products = mapOf(GTIN to "Вода 0,5 л"))
        val vm = vm(gateway)
        vm.next()
        assertEquals(WriteoffStep.LIST, vm.state.value.step)
        emit(km("SERIAL01"))
        vm.state.first { it.unitCount == 1 }
        vm.next()
        assertEquals(WriteoffStep.REASON, vm.state.value.step)
        vm.toConfirm()
        assertEquals(WriteoffStep.REASON, vm.state.value.step)
        vm.confirm()
        assertTrue(gateway.filed.isEmpty())
    }

    @Test
    fun confirmFilesThroughTheGatewayAndShowsTheResult() = runTest {
        val gateway = FakeGateway(products = mapOf(GTIN to "Вода 0,5 л"))
        val vm = vm(gateway)
        emit(km("SERIAL01"))
        vm.state.first { it.unitCount == 1 }
        vm.next()
        vm.selectReason(REASON)
        vm.toConfirm()
        vm.confirm()
        val ui = vm.state.first { it.step == WriteoffStep.RESULT }
        assertEquals(1, gateway.filed.size)
        assertEquals(REASON.id, gateway.filed.single().second.id)
        assertEquals("op-1", gateway.filed.single().first)
        assertNotNull(ui.filedDocumentId)
        assertEquals("pending", vm.state.first { it.filed != null }.filed?.state)
    }

    @Test
    fun noPermissionBlocksTheModeBeforeAnyScan() = runTest {
        val vm = vm(FakeGateway(products = mapOf(GTIN to "Вода 0,5 л"), permitted = false))
        val ui = vm.state.first { it.blocked != null }
        assertEquals(Blocked.NO_PERMISSION, ui.blocked)
        emit(km("SERIAL01"))
        assertEquals(0, vm.state.value.unitCount)
    }

    @Test
    fun neverSyncedBlocksTheModeInsteadOfLettingAScanThrough() = runTest {
        val vm = vm(FakeGateway(products = mapOf(GTIN to "Вода 0,5 л"), ready = false))
        assertEquals(Blocked.NEVER_SYNCED, vm.state.first { it.blocked != null }.blocked)
    }

    @Test
    fun anEmptyReasonDictionaryBlocksTheMode() = runTest {
        val vm = vm(FakeGateway(products = mapOf(GTIN to "Вода 0,5 л"), reasons = emptyList()))
        assertEquals(Blocked.NO_REASONS, vm.state.first { it.blocked != null }.blocked)
    }

    /** Back must not silently drop a list an operator spent minutes building. */
    @Test
    fun backStepsInsideTheModeAndAsksBeforeDiscardingALisT() = runTest {
        val vm = vm(FakeGateway(products = mapOf(GTIN to "Вода 0,5 л")))
        assertFalse(vm.back())
        emit(km("SERIAL01"))
        vm.state.first { it.unitCount == 1 }
        assertTrue(vm.back())
        assertTrue(vm.state.value.confirmDiscard)
        vm.dismissDiscard()
        vm.next()
        vm.selectReason(REASON)
        vm.toConfirm()
        assertTrue(vm.back())
        assertEquals(WriteoffStep.REASON, vm.state.value.step)
        assertTrue(vm.back())
        assertEquals(WriteoffStep.LIST, vm.state.value.step)
    }

    @Test
    fun removingALineUpdatesBothCounters() = runTest {
        val vm = vm(
            FakeGateway(
                products = mapOf(GTIN to "Вода 0,5 л"),
                productsById = mapOf("p-1" to "Вода 0,5 л"),
                boxes = mapOf(SSCC to WriteoffBoxEntity(SSCC, "b-1", "p-1", 12, "[]", "t")),
            ),
        )
        emit(km("SERIAL01"))
        vm.state.first { it.unitCount == 1 }
        emit(SSCC)
        val listed = vm.state.first { it.boxCount == 1 }
        assertEquals(13, listed.unitCount)
        vm.remove(listed.lines.first { it is WriteoffLine.Box })
        assertEquals(1, vm.state.value.unitCount)
        assertEquals(0, vm.state.value.boxCount)
    }

    @Test
    fun aScanThatIsNeitherCodeNorBoxIsRefused() = runTest {
        val vm = vm(FakeGateway())
        emit("hello")
        assertEquals(Verdict.NotACode, vm.state.first { it.lastVerdict != null }.lastVerdict)
    }

    private companion object {
        const val GTIN = "04600682000013"
        const val SSCC = "046000000000000022"
        val REASON = WriteoffReasonEntity("r-1", "Бой", 0)
    }
}
