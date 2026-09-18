package app.markiro.handheld.core.exceptions

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.storage.BoxEntity
import app.markiro.handheld.core.storage.BoxRegistryEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MembershipStatus
import app.markiro.handheld.core.storage.PalletEntity
import app.markiro.handheld.core.storage.PalletKind
import app.markiro.handheld.core.storage.PalletMembershipEntity
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Taking a closed pallet apart (spec §3.2).
 *
 * The pallet half of [ExceptionEngineTest]: the box cases live there, and these
 * exercise the second channel -- `pallet_exceptions` -- whose fact shape and
 * ordering rules are its own.
 */
@RunWith(AndroidJUnit4::class)
class ExceptionEnginePalletTest {
    private lateinit var db: HandheldDatabase
    private val now = 1_757_577_600_000L
    private lateinit var engine: ExceptionEngine

    @Before
    fun setUp() = runTest {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        engine = ExceptionEngine(db) { now }
        db.initializeRecoveryForTest()
    }

    @After
    fun tearDown() = db.close()

    private suspend fun warehousePallet(palletId: String = "p1", closedAt: String? = "2026-09-11T08:00:00.000Z") {
        db.palletDao().insert(
            PalletEntity(
                palletId = palletId, shiftId = null, terminalId = "dev-1", sscc = "146800899000000012",
                openedAt = "2026-09-11T07:00:00.000Z", closedAt = closedAt, operatorId = "op-1",
                printState = "printed", printReason = null, ackedAt = null,
                kind = PalletKind.WAREHOUSE, productId = "prod-1", deviceId = "dev-1",
            ),
        )
    }

    private suspend fun member(palletId: String, sscc: String) {
        db.boxRegistryDao().upsert(
            BoxRegistryEntity(
                sscc = sscc, boxId = "box-$sscc", productId = "prod-1", bottleCount = 12,
                contentKeysJson = "[]", updatedAt = "2026-09-11T07:10:00.000Z", localPalletId = palletId,
            ),
        )
        db.palletMembershipDao().insert(
            PalletMembershipEntity(
                palletId = palletId, sscc = sscc, addedAt = "2026-09-11T07:20:00.000Z", operatorId = "op-1",
                status = MembershipStatus.ACCEPTED, reason = null, winningPalletSscc = null,
                ackedAt = "2026-09-11T07:21:00.000Z", acknowledgedAt = null, bottleCount = 12,
            ),
        )
    }

    @Test
    fun retiringAWarehousePalletReleasesItsClaimsAndQueuesTheFact() = runTest {
        warehousePallet()
        member("p1", "046800899000000018")
        member("p1", "046800899000000025")

        assertEquals(
            DisassemblePalletResult.Retired,
            engine.disassemblePallet("p1", DisassembleReason.DAMAGED_PACKAGE, "op-1", "dev-1"),
        )

        assertNotNull(db.palletDao().get("p1")?.disassembledAt)
        // The claims are what keep those boxes off every other pallet; they go
        // back to the registry the moment the stack is taken apart.
        assertEquals(emptyList<BoxRegistryEntity>(), db.boxRegistryDao().claimed())
        // Membership rows stay: this pallet DID carry these boxes, and that is history.
        assertEquals(2, db.palletMembershipDao().byPallet("p1").size)

        val queued = db.palletExceptionDao().queued().single()
        assertEquals("disassemble", queued.kind)
        assertEquals("p1", queued.palletId)
        assertNull(queued.shiftId)
        assertEquals(DisassembleReason.DAMAGED_PACKAGE.audit, queued.reason)
        val payload = Json.parseToJsonElement(queued.payloadJson).jsonObject
        assertEquals(JsonNull, payload.getValue("shiftId"))
        assertEquals("disassemble", payload.getValue("kind").jsonPrimitive.content)
        assertEquals(
            listOf("kind", "palletId", "shiftId", "terminalId", "operatorId", "reason", "occurredAt"),
            payload.keys.toList(),
        )
    }

    @Test
    fun aProductionPalletCarriesItsShiftOnTheFact() = runTest {
        db.palletDao().insert(
            PalletEntity(
                palletId = "p2", shiftId = "s1", terminalId = "dev-1", sscc = "146800899000000029",
                openedAt = "2026-09-11T07:00:00.000Z", closedAt = "2026-09-11T08:00:00.000Z", operatorId = "op-1",
                printState = "printed", printReason = null, ackedAt = null,
            ),
        )
        db.boxDao().insert(
            BoxEntity(
                boxId = "box-1", shiftId = "s1", sscc = "046800899000000018",
                openedAt = "2026-09-11T07:00:00.000Z", closedAt = "2026-09-11T07:30:00.000Z",
                operatorId = "op-1", printState = "printed", printReason = null, ackedAt = null,
                palletId = "p2",
            ),
        )

        assertEquals(
            DisassemblePalletResult.Retired,
            engine.disassemblePallet("p2", DisassembleReason.WRONG_PRODUCT, "op-1", "dev-1"),
        )
        val queued = db.palletExceptionDao().queued().single()
        assertEquals("s1", queued.shiftId)
        assertEquals("s1", Json.parseToJsonElement(queued.payloadJson).jsonObject.getValue("shiftId").jsonPrimitive.content)
    }

    @Test
    fun aSecondRetirementIsRefusedAndQueuesNothing() = runTest {
        warehousePallet()
        engine.disassemblePallet("p1", DisassembleReason.WRONG_QUANTITY, "op-1", "dev-1")
        assertEquals(
            DisassemblePalletResult.AlreadyRetired,
            engine.disassemblePallet("p1", DisassembleReason.WRONG_QUANTITY, "op-1", "dev-1"),
        )
        assertEquals(1, db.palletExceptionDao().queued().size)
    }

    @Test
    fun anOpenPalletIsRefused() = runTest {
        warehousePallet(closedAt = null)
        assertEquals(
            DisassemblePalletResult.NotClosed,
            engine.disassemblePallet("p1", DisassembleReason.QUALITY_REJECTED, "op-1", "dev-1"),
        )
        assertNull(db.palletDao().get("p1")?.disassembledAt)
        assertEquals(emptyList<Long>(), db.palletExceptionDao().queued().map { it.id })
    }

    @Test
    fun anUnknownPalletIsRefused() = runTest {
        assertEquals(
            DisassemblePalletResult.NotClosed,
            engine.disassemblePallet("nope", DisassembleReason.WRONG_PRODUCT, "op-1", "dev-1"),
        )
    }
}
