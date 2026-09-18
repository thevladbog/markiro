package app.markiro.handheld.core.pallets

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.box.ClosePallet
import app.markiro.handheld.core.box.ClosePalletResult
import app.markiro.handheld.core.box.PalletLock
import app.markiro.handheld.core.box.ServerRange
import app.markiro.handheld.core.box.SsccPool
import app.markiro.handheld.core.storage.BoxRegistryEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MembershipStatus
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.storage.PalletKind
import app.markiro.handheld.core.storage.PalletMembershipEntity
import app.markiro.handheld.core.storage.PalletProductEntity
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The warehouse pallet's own lifecycle (spec §3.2-§3.4): the first accepted
 * scan opens it, the six refusals hold their spec order, removal only takes a
 * pending row back, and closing either burns exactly one extension-1 serial or
 * leaves the pallet open.
 */
@RunWith(AndroidJUnit4::class)
class WarehousePalletsTest {
    private lateinit var db: HandheldDatabase
    private lateinit var pool: SsccPool
    private lateinit var meta: MetaStore
    private lateinit var pallets: WarehousePallets
    private var now = 1_757_000_000_000L

    private companion object {
        const val PREFIX = "046006820"

        /** 14 digits each; a bare `"…$id"` would not be a GTIN at all. */
        val GTINS = mapOf("p-1" to "04600682000017", "p-2" to "04600682000024")
    }

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        pool = SsccPool(db)
        meta = MetaStore(db)
        val lock = PalletLock(db)
        pallets = WarehousePallets(db, lock, ClosePallet(db, pool, lock) { now }, meta) { now }
        db.initializeRecoveryForTest()
    }

    @After
    fun tearDown() = db.close()

    private suspend fun registry(
        sscc: String,
        productId: String = "p-1",
        palletActive: Boolean = false,
        palletSscc: String? = null,
        localPalletId: String? = null,
        productionDate: String = "2026-09-10",
        bottleCount: Int = 6,
    ) = db.boxRegistryDao().upsert(
        BoxRegistryEntity(
            sscc = sscc, boxId = "b-$sscc", productId = productId, bottleCount = bottleCount, contentKeysJson = "[]",
            updatedAt = "t", palletId = if (palletActive) "srv" else null, palletSscc = palletSscc,
            palletActive = palletActive, closedAt = "c", productionDate = productionDate, localPalletId = localPalletId,
        ),
    )

    private suspend fun product(id: String = "p-1", capacity: Int? = 2) {
        val existing = listOf("p-1", "p-2").filter { it != id }.mapNotNull { db.palletProductDao().byId(it) }
        db.palletProductDao().replaceAll(
            existing + PalletProductEntity(id, GTINS.getValue(id), "Cola $id", null, 180, capacity, 8),
        )
    }

    private suspend fun deviceId() = db.deviceConfigDao().get()!!.deviceId

    @Test
    fun theFirstAcceptedScanOpensThePalletWithTheBoxProduct() = runTest {
        product()
        registry("034600682000000018")
        val r = pallets.attach("034600682000000018", "op-1") as AttachResult.Attached
        assertEquals(PalletKind.WAREHOUSE, r.pallet.kind)
        assertEquals("p-1", r.pallet.productId)
        assertNull(r.pallet.shiftId)
        assertEquals(deviceId(), r.pallet.deviceId)
        assertEquals(r.pallet.deviceId, r.pallet.terminalId)
        assertEquals(1, r.boxCount)
        assertEquals(2, r.capacity)
        assertFalse(r.atCapacity)
        // The device's own claim, so a second scan before the next registry
        // refresh is still caught.
        assertEquals(r.pallet.palletId, db.boxRegistryDao().bySscc("034600682000000018")?.localPalletId)
        val membership = db.palletMembershipDao().byPallet(r.pallet.palletId).single()
        assertEquals(MembershipStatus.PENDING, membership.status)
        // Snapshot at attach: the pallet label must not lose units when the
        // registry mirror later drops the box's row.
        assertEquals(6, membership.bottleCount)
        assertEquals("2026-09-10", membership.productionDate)
        assertEquals(6, db.palletMembershipDao().bottleSum(r.pallet.palletId))
    }

    @Test
    fun refusalsInSpecOrder() = runTest {
        product()
        product("p-2", 5)
        assertEquals(AttachResult.UnknownBox, pallets.attach("034600682000000999", null))
        registry("034600682000000025", localPalletId = "other-local")
        assertEquals(AttachResult.OnAnotherLocalPallet, pallets.attach("034600682000000025", null))
        registry("034600682000000032", palletActive = true, palletSscc = "134600682000000017")
        assertEquals(AttachResult.OnAnotherPallet("134600682000000017"), pallets.attach("034600682000000032", null))
        registry("034600682000000018")
        pallets.attach("034600682000000018", null)
        assertEquals(AttachResult.AlreadyOnThisPallet, pallets.attach("034600682000000018", null))
        registry("034600682000000049", productId = "p-2")
        assertEquals(AttachResult.OtherProduct("Cola p-2"), pallets.attach("034600682000000049", null))
        // The registry never lists a pallet, so an extension-1 SSCC must not
        // read as an unknown box.
        assertEquals(AttachResult.ThatIsAPallet, pallets.attach("134600682000000017", null))
    }

    @Test
    fun aClosedForeignPalletOutranksAPendingMembershipOnOurOwnOpenPallet() = runTest {
        // The box has a PENDING (not yet server-acked) membership row on our
        // own open pallet -- exactly what `AlreadyOnThisPallet` would
        // otherwise treat as the soft, idempotent duplicate -- but its
        // registry row now says another device already CLOSED a pallet
        // around it. The concrete foreign SSCC must win: it is a genuine,
        // already-settled cross-device conflict, not a re-scan of our own
        // claim.
        product()
        registry("034600682000000018")
        pallets.attach("034600682000000018", "op-1")
        registry(
            "034600682000000018",
            palletActive = true, palletSscc = "134600682000000099",
        )
        assertEquals(
            AttachResult.OnAnotherPallet("134600682000000099"),
            pallets.attach("034600682000000018", "op-1"),
        )
    }

    @Test
    fun onAnotherLocalPalletWinsWhenPalletActiveIsAlsoSetWithoutAConcreteSscc() = runTest {
        // A registry row can carry BOTH a stale `localPalletId` (this device's
        // own earlier claim, on a pallet that is not the currently open one)
        // AND `palletActive = true` with `palletSscc` still null (an open
        // pallet somewhere, not yet a settled foreign closure). Absent a
        // concrete foreign SSCC, `OnAnotherLocalPallet` must win: it is this
        // device's own conflict to resolve, not a report about a foreign
        // pallet.
        product()
        registry("034600682000000018")
        pallets.attach("034600682000000018", null)
        registry(
            "034600682000000025", localPalletId = "other-local",
            palletActive = true, palletSscc = null,
        )
        assertEquals(AttachResult.OnAnotherLocalPallet, pallets.attach("034600682000000025", null))
    }

    @Test
    fun aClosedForeignPalletOutranksALocalMembershipClaim() = runTest {
        // A concrete (non-null) `palletSscc` means another device already
        // CLOSED a pallet around this box: a real, already-settled conflict
        // that outranks a stale `localPalletId` claim this device still holds.
        product()
        registry("034600682000000018")
        pallets.attach("034600682000000018", null)
        registry(
            "034600682000000025", localPalletId = "other-local",
            palletActive = true, palletSscc = "134600682000000017",
        )
        assertEquals(
            AttachResult.OnAnotherPallet("134600682000000017"),
            pallets.attach("034600682000000025", null),
        )
    }

    @Test
    fun alreadyOnThisPalletWinsOverOtherProduct() = runTest {
        // An accepted membership on the open pallet whose registry product no
        // longer matches the pallet's product (a bootstrap/product edit after
        // the scan, say) must still read as the soft duplicate, not as a
        // product conflict with itself.
        product()
        product("p-2", 5)
        registry("034600682000000018")
        val opened = pallets.attach("034600682000000018", "op-1") as AttachResult.Attached
        db.palletMembershipDao().markAccepted(opened.pallet.palletId, "034600682000000018", "t")
        db.boxRegistryDao().upsert(
            db.boxRegistryDao().bySscc("034600682000000018")!!.copy(productId = "p-2"),
        )
        assertEquals(AttachResult.AlreadyOnThisPallet, pallets.attach("034600682000000018", "op-1"))
    }

    @Test
    fun aBoxWhoseProductIsNotMirroredYetIsRefusedByName() = runTest {
        registry("034600682000000018")
        assertEquals(AttachResult.UnknownProduct, pallets.attach("034600682000000018", null))
    }

    @Test
    fun aRegistryBoxOnADisassembledPalletIsFree() = runTest {
        product()
        db.boxRegistryDao().upsert(
            BoxRegistryEntity(
                "034600682000000018", "b", "p-1", 6, "[]", "t",
                palletId = "old", palletSscc = "134600682000000017", palletActive = false,
            ),
        )
        assertTrue(pallets.attach("034600682000000018", null) is AttachResult.Attached)
    }

    @Test
    fun aRejectedBoxCanBeScannedOntoTheSamePalletAgain() = runTest {
        product()
        registry("034600682000000018")
        val first = pallets.attach("034600682000000018", "op-1") as AttachResult.Attached
        db.palletMembershipDao().markRejected(
            first.pallet.palletId, "034600682000000018", "box_on_another_pallet", "134600682000000017", "t",
        )
        val again = pallets.attach("034600682000000018", "op-1") as AttachResult.Attached
        assertEquals(first.pallet.palletId, again.pallet.palletId)
        val membership = db.palletMembershipDao().byPallet(first.pallet.palletId).single()
        assertEquals(MembershipStatus.PENDING, membership.status)
        assertNull(membership.reason)
        assertNull(membership.winningPalletSscc)
        assertEquals(1, again.boxCount)
    }

    @Test
    fun atCapacityIsReportedAndAnExplicitCloseBurnsAnExtensionOneSerial() = runTest {
        product()
        pool.addRange(ServerRange(PREFIX, SsccPool.PALLET_EXTENSION_DIGIT, 0, 199, null))
        meta.put(MetaStore.PALLET_BOOTSTRAP_ISSUER_PREFIX, PREFIX)
        registry("034600682000000018")
        registry("034600682000000025")
        pallets.attach("034600682000000018", "op-1")
        val second = pallets.attach("034600682000000025", "op-1") as AttachResult.Attached
        assertTrue(second.atCapacity)
        val closed = pallets.close("op-1") as ClosePalletResult.Closed
        assertEquals(2, closed.boxCount)
        assertTrue(closed.sscc.startsWith("1$PREFIX"))
        assertNull(db.palletDao().openWarehouse(second.pallet.deviceId!!))
        assertEquals(199L, pool.remaining(PREFIX, SsccPool.PALLET_EXTENSION_DIGIT))
    }

    @Test
    fun noIssuerOrNoSerialsLeavesThePalletOpen() = runTest {
        product()
        registry("034600682000000018")
        pallets.attach("034600682000000018", null)
        assertEquals(ClosePalletResult.NoIssuer, pallets.close(null))
        meta.put(MetaStore.PALLET_BOOTSTRAP_ISSUER_PREFIX, PREFIX)
        assertEquals(ClosePalletResult.NoSerials, pallets.close(null))
        assertNotNull(db.palletDao().openWarehouse(deviceId()))
    }

    @Test
    fun closingWithNoOpenPalletIsEmptyNotAnError() = runTest {
        meta.put(MetaStore.PALLET_BOOTSTRAP_ISSUER_PREFIX, PREFIX)
        pool.addRange(ServerRange(PREFIX, SsccPool.PALLET_EXTENSION_DIGIT, 0, 199, null))
        assertEquals(ClosePalletResult.Empty, pallets.close("op-1"))
        assertEquals(200L, pool.remaining(PREFIX, SsccPool.PALLET_EXTENSION_DIGIT))
    }

    @Test
    fun removeOnlyTakesAPendingRowAndReleasesTheClaim() = runTest {
        product()
        registry("034600682000000018")
        val r = pallets.attach("034600682000000018", null) as AttachResult.Attached
        assertTrue(pallets.remove(r.pallet.palletId, "034600682000000018"))
        assertNull(db.boxRegistryDao().bySscc("034600682000000018")?.localPalletId)
        registry("034600682000000025")
        pallets.attach("034600682000000025", null)
        // A `sent` row may already be on the server; only the server can take
        // that one back.
        db.palletMembershipDao().markSent(r.pallet.palletId, "034600682000000025")
        assertFalse(pallets.remove(r.pallet.palletId, "034600682000000025"))
        assertEquals(r.pallet.palletId, db.boxRegistryDao().bySscc("034600682000000025")?.localPalletId)
    }

    @Test
    fun acknowledgingARejectionClearsTheBanner() = runTest {
        product()
        registry("034600682000000018")
        val r = pallets.attach("034600682000000018", "op-1") as AttachResult.Attached
        db.palletMembershipDao().markRejected(r.pallet.palletId, "034600682000000018", "box_on_another_pallet", null, "t")
        pallets.acknowledgeRejections(r.pallet.palletId)
        assertNotNull(db.palletMembershipDao().byPallet(r.pallet.palletId).single().acknowledgedAt)
    }

    @Test
    fun capacityIsReadFromTheProductMirror() = runTest {
        product(capacity = 24)
        registry("034600682000000018")
        val r = pallets.attach("034600682000000018", null) as AttachResult.Attached
        assertEquals(24, pallets.capacity(r.pallet))
    }

    @Test
    fun productionDatesReflectsEveryDistinctMemberDate() = runTest {
        product(capacity = 10)
        registry("034600682000000018", productionDate = "2026-09-10")
        registry("034600682000000025", productionDate = "2026-09-11")
        val opened = pallets.attach("034600682000000018", null) as AttachResult.Attached
        pallets.attach("034600682000000025", null)
        assertEquals(
            setOf("2026-09-10", "2026-09-11"),
            db.palletMembershipDao().productionDates(opened.pallet.palletId).toSet(),
        )
    }

    @Test
    fun productionDatesIsOneValueWhenEveryMemberSharesIt() = runTest {
        product(capacity = 10)
        registry("034600682000000018", productionDate = "2026-09-10")
        registry("034600682000000025", productionDate = "2026-09-10")
        val opened = pallets.attach("034600682000000018", null) as AttachResult.Attached
        pallets.attach("034600682000000025", null)
        assertEquals(listOf("2026-09-10"), db.palletMembershipDao().productionDates(opened.pallet.palletId))
    }

    @Test
    fun bottleSumAndCountOnPalletExcludeARejectedRow() = runTest {
        product(capacity = 10)
        registry("034600682000000018", bottleCount = 6)
        registry("034600682000000025", bottleCount = 4)
        val opened = pallets.attach("034600682000000018", null) as AttachResult.Attached
        pallets.attach("034600682000000025", null)
        db.palletMembershipDao().markRejected(
            opened.pallet.palletId, "034600682000000025", "box_on_another_pallet", null, "t",
        )
        assertEquals(6, db.palletMembershipDao().bottleSum(opened.pallet.palletId))
        assertEquals(1, db.palletMembershipDao().countOnPallet(opened.pallet.palletId))
    }
    /**
     * The device-wide rejection feed, which is what lets a rejection that
     * lands AFTER its pallet was closed and labelled still reach the operator.
     * It is scoped to this device's own warehouse pallets: another terminal's
     * conflict is not this one's work, and a production pallet belongs to the
     * shift screens and carries no memberships of its own.
     */
    @Test
    fun theDeviceWideRejectionFeedSeesOnlyThisDevicesWarehousePallets() = runTest {
        product(capacity = 10)
        registry("034600682000000018")
        val mine = (pallets.attach("034600682000000018", null) as AttachResult.Attached).pallet
        db.palletMembershipDao().markRejected(mine.palletId, "034600682000000018", "already_on_pallet", null, "t")
        // Closing the pallet must not hide its rejection: that is precisely the
        // case whose printed label now overstates the stack.
        db.palletDao().close(mine.palletId, "134600682000000017", "t", null)

        val foreign = mine.copy(palletId = "foreign", deviceId = "other-device", terminalId = "other-device", sscc = null, closedAt = null)
        db.palletDao().insert(foreign)
        db.palletMembershipDao().insert(
            PalletMembershipEntity(
                palletId = "foreign", sscc = "034600682000000025", addedAt = "t", operatorId = null,
                status = MembershipStatus.REJECTED, reason = "not_found", winningPalletSscc = null,
                ackedAt = "t", acknowledgedAt = null,
            ),
        )
        val production = mine.copy(
            palletId = "prod", kind = PalletKind.PRODUCTION, shiftId = "sh-1", sscc = null, closedAt = null,
        )
        db.palletDao().insert(production)
        db.palletMembershipDao().insert(
            PalletMembershipEntity(
                palletId = "prod", sscc = "034600682000000032", addedAt = "t", operatorId = null,
                status = MembershipStatus.REJECTED, reason = "not_found", winningPalletSscc = null,
                ackedAt = "t", acknowledgedAt = null,
            ),
        )

        val rows = db.palletMembershipDao().observeUnacknowledgedRejectionsForDevice(deviceId()).first()
        assertEquals(listOf(mine.palletId), rows.map { it.palletId })
        assertEquals(listOf("034600682000000018"), rows.map { it.sscc })

        // «Принято» takes it off the feed, and only for the pallet named.
        db.palletMembershipDao().acknowledge(mine.palletId, "t")
        assertTrue(db.palletMembershipDao().observeUnacknowledgedRejectionsForDevice(deviceId()).first().isEmpty())
    }

    /**
     * An unpaired device cannot answer the check at all -- there is no owner to
     * write a pallet against. «Короб неизвестен. Обновите реестр» would be a
     * wrong diagnosis that sends the operator to refresh a registry that is not
     * the problem, and they would keep scanning a box that can never be taken.
     */
    @Test
    fun anUnpairedDeviceIsUnavailableRatherThanAnUnknownBox() = runTest {
        product()
        registry("034600682000000018")
        db.deviceConfigDao().clear()
        assertEquals(AttachResult.Unavailable, pallets.attach("034600682000000018", null))
    }
}
