package app.markiro.handheld.core.host

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.box.BoxDigest
import app.markiro.handheld.core.host.HostFactsFixtures.BOX_BLOCK
import app.markiro.handheld.core.host.HostFactsFixtures.GS
import app.markiro.handheld.core.host.HostFactsFixtures.KM_A
import app.markiro.handheld.core.host.HostFactsFixtures.KM_B
import app.markiro.handheld.core.host.HostFactsFixtures.KM_C
import app.markiro.handheld.core.host.HostFactsFixtures.PALLET_BLOCK
import app.markiro.handheld.core.km.KmCodec
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.HostOutboxEntity
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class HostRecordFreezerTest {
    private lateinit var db: HandheldDatabase
    private var ids = 0

    @Before
    fun open() = kotlinx.coroutines.runBlocking {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        db.deviceConfigDao().upsert(HostFactsFixtures.config(db))
        db.initializeRecoveryForTest()
        db.shiftDao().upsert(HostFactsFixtures.shift())
        HostFactsFixtures.pool(db)
    }

    @After
    fun close() = db.close()

    private fun freezer(clock: String = "2026-10-15T08:00:05.000Z") =
        HostRecordFreezer(db, clock = { clock }, newId = { "00000000-0000-4000-8000-%012d".format(++ids) })

    private suspend fun queued(): List<HostOutboxEntity> = db.hostOutboxDao().queuedFor("facts", 100)

    private fun body(row: HostOutboxEntity): JsonObject = Json.parseToJsonElement(row.body).jsonObject

    @Test
    fun anAcceptedScanIsOneRecordInTheShapeOfTheHostsFixtureAndASecondPassMakesNothing() = runTest {
        db.outboxDao().insert(HostFactsFixtures.scanRow(KM_A, boxId = "8e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b"))
        assertEquals(1, freezer().freezeAll())
        assertEquals(0, freezer().freezeAll())
        val row = queued().single()
        assertEquals("facts", row.target)
        assertEquals("scan", row.kind)
        val record = body(row)
        assertEquals(row.recordId, record.getValue("id").jsonPrimitive.content)
        assertEquals(HostFactsFixtures.shape(HostFactsFixtures.fixtureRecord("facts-request.json", "scan")), HostFactsFixtures.shape(record))
        val data = record.getValue("data").jsonObject
        assertEquals("2026-10-08T06:15:02.418Z", data.getValue("scannedAt").jsonPrimitive.content)
        assertEquals(KM_A.length, data.getValue("rawLength").jsonPrimitive.content.toInt())
        val code = data.getValue("code").jsonObject
        assertEquals(KmCodec.hash(KmCodec.canonicalize(KM_A)), code.getValue("codeHash").jsonPrimitive.content)
        assertEquals("010460068200001321aaa${GS}93AAAA", code.getValue("canonical").jsonPrimitive.content)
    }

    @Test
    fun theBodyIsFrozenAndAnotherPassNeverRebuildsOrReissuesIt() = runTest {
        val boxId = "8e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b"
        db.boxDao().insert(HostFactsFixtures.closedBox(boxId, 1500))
        db.codeDao().insert(HostFactsFixtures.code(KM_A, boxId))
        freezer("2026-10-15T08:00:05.000Z").freezeAll()
        val first = queued().single()
        db.codeDao().insert(HostFactsFixtures.code(KM_B, boxId)) // the box now holds more than when it was frozen
        assertEquals(0, freezer("2026-10-15T09:00:00.000Z").freezeAll())
        assertEquals(first, queued().single())
    }

    @Test
    fun anInvalidScanKeepsNoTextAndMatchesTheFixtureOfAnInvalidScan() = runTest {
        db.outboxDao().insert(HostFactsFixtures.scanRow("hello", verdict = "invalid", at = "2026-10-08T06:15:04.007Z", km = false))
        freezer().freezeAll()
        val record = body(queued().single())
        val fixture = HostFactsFixtures.fixture("facts-request.json").getValue("records")
            .let { (it as kotlinx.serialization.json.JsonArray)[1].jsonObject }
        assertEquals(HostFactsFixtures.shape(fixture), HostFactsFixtures.shape(record))
        val data = record.getValue("data").jsonObject
        assertEquals("unknown", data.getValue("rawKind").jsonPrimitive.content)
        assertEquals(5, data.getValue("rawLength").jsonPrimitive.content.toInt())
        assertTrue(!record.toString().contains("hello"))
    }

    @Test
    fun aWrongGtinScanCarriesTheCodeTheDeviceReadFromTheRawTextAndADuplicateNamesItsLocalSource() = runTest {
        val other = "010460068200002021zzz${GS}93ZZZZ" // another product's GTIN
        db.outboxDao().insert(HostFactsFixtures.scanRow(other, verdict = "wrong_gtin", km = false))
        db.outboxDao().insert(HostFactsFixtures.scanRow(KM_A, verdict = "duplicate", km = false))
        freezer().freezeAll()
        val (wrong, duplicate) = queued().map { body(it).getValue("data").jsonObject }
        assertEquals("km", wrong.getValue("rawKind").jsonPrimitive.content)
        assertEquals(KmCodec.canonicalize(other).gtin14, wrong.getValue("code").jsonObject.getValue("gtin14").jsonPrimitive.content)
        assertEquals("local", duplicate.getValue("duplicateSource").jsonPrimitive.content)
        assertEquals("null", wrong.getValue("duplicateSource").toString())
        assertEquals("null", wrong.getValue("boxId").toString())
    }

    @Test
    fun aScanThatContradictsItselfIsQuarantinedForSupportAndHoldsNothingBack() = runTest {
        db.outboxDao().insert(HostFactsFixtures.scanRow(KM_A, verdict = "invalid", km = false)) // a code of marking said "invalid"
        db.outboxDao().insert(HostFactsFixtures.scanRow(KM_B, boxId = "8e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b"))
        freezer().freezeAll()
        assertEquals(1, queued().size)
        assertEquals(listOf("bad_scan"), db.hostOutboxDao().quarantined().map { it.reason })
        assertEquals(0, freezer().freezeAll())
    }

    @Test
    fun aClosedBoxCarriesItsBlockSerialAndTheDigestOfItsCodes() = runTest {
        val boxId = "8e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b"
        db.boxDao().insert(HostFactsFixtures.closedBox(boxId, 1500))
        listOf(KM_B, KM_A, KM_C).forEach { db.codeDao().insert(HostFactsFixtures.code(it, boxId)) }
        freezer().freezeAll()
        val record = body(queued().single())
        assertEquals(HostFactsFixtures.shape(HostFactsFixtures.fixtureRecord("facts-request.json", "box_closed")), HostFactsFixtures.shape(record))
        val data = record.getValue("data").jsonObject
        val hashes = listOf(KM_B, KM_A, KM_C).map { KmCodec.hash(KmCodec.canonicalize(it)) }
        assertEquals(BoxDigest.of(hashes), data.getValue("membershipDigest").jsonPrimitive.content)
        assertEquals(3, data.getValue("itemCount").jsonPrimitive.content.toInt())
        assertEquals(1500L, data.getValue("serial").jsonPrimitive.content.toLong())
        assertEquals(BOX_BLOCK, data.getValue("blockId").jsonPrimitive.content)
        assertEquals("046006820000015000", data.getValue("sscc").jsonPrimitive.content)
        assertEquals("2026-10-08T06:15:02.418Z", data.getValue("openedAt").jsonPrimitive.content)
        assertEquals(HostFactsFixtures.OPERATOR, record.getValue("operatorId").jsonPrimitive.content)
    }

    @Test
    fun aBoxOnAPalletNamesItAndAPalletClosureMatchesTheFixtureOfPallets() = runTest {
        val boxId = "8e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b"
        val palletId = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"
        db.boxDao().insert(HostFactsFixtures.closedBox(boxId, 1500, palletId = palletId))
        db.codeDao().insert(HostFactsFixtures.code(KM_A, boxId))
        db.palletDao().insert(HostFactsFixtures.closedPallet(palletId, 40))
        freezer().freezeAll()
        val (box, pallet) = queued().map { body(it) }
        assertEquals(HostFactsFixtures.shape(HostFactsFixtures.fixtureRecord("facts-request-pallets.json", "box_closed")), HostFactsFixtures.shape(box))
        assertEquals(HostFactsFixtures.shape(HostFactsFixtures.fixtureRecord("facts-request-pallets.json", "pallet_closed")), HostFactsFixtures.shape(pallet))
        val data = pallet.getValue("data").jsonObject
        assertEquals(PALLET_BLOCK, data.getValue("blockId").jsonPrimitive.content)
        assertEquals(40L, data.getValue("serial").jsonPrimitive.content.toLong())
        assertEquals(1, data.getValue("boxCount").jsonPrimitive.content.toInt())
        assertEquals("146006820000000409", data.getValue("sscc").jsonPrimitive.content)
    }

    @Test
    fun aWarehousePalletBelongsToNoShiftAndIsLeftToThePalletEventsChannel() = runTest {
        db.palletDao().insert(
            HostFactsFixtures.closedPallet("a1000000-0000-4000-8000-000000000001", 41)
                .copy(shiftId = null, kind = app.markiro.handheld.core.storage.PalletKind.WAREHOUSE, deviceId = "d"),
        )
        assertEquals(0, freezer().freezeAll())
    }

    @Test
    fun aShiftCloseIsKnownByItsOwnEventIdAndMatchesTheFixture() = runTest {
        db.shiftCloseDao().insert(HostFactsFixtures.shiftClose("ad7c3f5a-8b6e-4c2d-9f0a-5b7c9d1e3f65"))
        freezer().freezeAll()
        val row = queued().single()
        assertEquals("ad7c3f5a-8b6e-4c2d-9f0a-5b7c9d1e3f65", row.recordId)
        assertEquals(HostFactsFixtures.shape(HostFactsFixtures.fixtureRecord("facts-request.json", "shift_closed")), HostFactsFixtures.shape(body(row)))
        assertEquals(HostFactsFixtures.fixtureRecord("facts-request.json", "shift_closed").getValue("data"), body(row).getValue("data"))
    }

    @Test
    fun theTimeOfTheDeviceOrdersTheRecordsOfOnePassNotTheOrderOfTheTables() = runTest {
        val boxId = "8e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b"
        db.boxDao().insert(HostFactsFixtures.closedBox(boxId, 1500, closedAt = "2026-10-08T06:21:47.302Z"))
        db.codeDao().insert(HostFactsFixtures.code(KM_A, boxId))
        db.outboxDao().insert(HostFactsFixtures.scanRow(KM_A, at = "2026-10-08T06:15:02.418Z", boxId = boxId))
        db.outboxDao().insert(HostFactsFixtures.scanRow(KM_B, at = "2026-10-08T07:00:00.000Z", boxId = "99999999-4c5d-4e6f-8a9b-0c1d2e3f4a5b"))
        db.shiftCloseDao().insert(HostFactsFixtures.shiftClose("ad7c3f5a-8b6e-4c2d-9f0a-5b7c9d1e3f65", closedAt = "2026-10-08T14:00:00.000Z"))
        freezer().freezeAll()
        assertEquals(listOf("scan", "box_closed", "scan", "shift_closed"), queued().map { it.kind })
        val seqs = queued().map { it.seq }
        assertEquals(seqs.sorted(), seqs)
    }

    @Test
    fun atTheSameInstantAScanComesBeforeTheBoxItFillsAndTheBoxBeforeItsPallet() = runTest {
        val instant = "2026-10-08T06:21:47.302Z"
        val boxId = "8e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b"
        val palletId = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"
        db.palletDao().insert(HostFactsFixtures.closedPallet(palletId, 40, closedAt = instant))
        db.boxDao().insert(HostFactsFixtures.closedBox(boxId, 1500, closedAt = instant, palletId = palletId))
        db.codeDao().insert(HostFactsFixtures.code(KM_A, boxId))
        db.shiftCloseDao().insert(HostFactsFixtures.shiftClose("ad7c3f5a-8b6e-4c2d-9f0a-5b7c9d1e3f65", closedAt = instant))
        db.outboxDao().insert(HostFactsFixtures.scanRow(KM_A, at = instant, boxId = boxId))
        freezer().freezeAll()
        assertEquals(listOf("scan", "box_closed", "pallet_closed", "shift_closed"), queued().map { it.kind })
    }

    @Test
    fun aTimeThatIsNotAnInstantOfTheDeviceIsQuarantinedWithItsReasonAndTheRestGoesOn() = runTest {
        db.outboxDao().insert(HostFactsFixtures.scanRow(KM_A, at = "2026-10-08T06:15:02Z", boxId = "8e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b")) // no milliseconds
        db.outboxDao().insert(HostFactsFixtures.scanRow(KM_B, boxId = "8e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b"))
        freezer().freezeAll()
        assertEquals(listOf("scan"), queued().map { it.kind })
        assertEquals(listOf("bad_device_time"), db.hostOutboxDao().quarantined().map { it.reason })
    }

    @Test
    fun aBoxOfASerialNoBlockHeldCoversIsQuarantinedNotSentWithAGuess() = runTest {
        db.boxDao().insert(HostFactsFixtures.closedBox("8e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b", 9000))
        freezer().freezeAll()
        assertEquals(0, queued().size)
        assertEquals(listOf("block_unknown"), db.hostOutboxDao().quarantined().map { it.reason })
    }

    @Test
    fun everyRecordHasAnIdOfItsOwn() = runTest {
        db.outboxDao().insert(HostFactsFixtures.scanRow(KM_A, boxId = "8e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b"))
        db.outboxDao().insert(HostFactsFixtures.scanRow(KM_B, boxId = "8e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b"))
        freezer().freezeAll()
        val all = queued().map { it.recordId }
        assertEquals(2, all.toSet().size)
        assertNotEquals(all[0], all[1])
    }
}
