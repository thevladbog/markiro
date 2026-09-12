package app.markiro.handheld.core.print

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.flow.first
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PrinterRoutingTest {
    private lateinit var db: HandheldDatabase
    private fun printer(id: String) = PrinterEntity(id, "Printer $id", "wifi", "$id:9100", "zpl", 203, true, null, null)
    @Before fun setup() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        db.initializeRecoveryForTest()
    }
    @After fun close() = db.close()

    @Test fun eachPurposeResolvesIndependentlyAndCanShareOnePrinter() = runTest {
        val dao = db.printerDao()
        PrintPurpose.entries.forEach { purpose ->
            dao.upsert(printer(purpose.wire))
            dao.assign(PrinterAssignmentEntity(purpose.wire, purpose.wire))
        }
        PrintPurpose.entries.forEach { assertEquals(it.wire, dao.assigned(it)?.id) }
        dao.assign(PrinterAssignmentEntity("pallet", "box"))
        assertEquals("box", dao.assigned(PrintPurpose.PALLET)?.id)
        assertEquals("duplicate", dao.assigned(PrintPurpose.DUPLICATE)?.id)
    }

    @Test fun missingAndDeletedAssignmentNeverUseLegacySelectedFlag() = runTest {
        val dao = db.printerDao()
        dao.upsert(printer("legacy"))
        assertNull(dao.assigned(PrintPurpose.BOX))
        dao.assign(PrinterAssignmentEntity("box", "legacy"))
        dao.assign(PrinterAssignmentEntity("box", null))
        assertNull(dao.assigned(PrintPurpose.BOX))
        dao.assign(PrinterAssignmentEntity("box", "missing"))
        assertNull(dao.assigned(PrintPurpose.BOX))
    }

    @Test fun attemptSnapshotSurvivesProfileEditDeleteAndAssignmentChange() = runTest {
        val dao = db.printerDao()
        dao.upsert(printer("a"))
        dao.assign(PrinterAssignmentEntity("box", "a"))
        val initial = PrintDestinations(db).retain(PrintPurpose.BOX, "job", "initial")
        dao.upsert(printer("a").copy(address = "changed:9100", language = "tspl", dpi = 300))
        dao.delete("a")
        dao.upsert(printer("b"))
        dao.assign(PrinterAssignmentEntity("box", "b"))
        assertEquals(initial, PrintDestinations(db).retain(PrintPurpose.BOX, "job", "initial"))
        assertEquals("a:9100", initial?.address)
        assertEquals("b", PrintDestinations(db).retain(PrintPurpose.PALLET, "job", "initial", printer("b"))?.id)
    }

    @Test fun anUnavailableEndpointNamesOnlyItsRolesAndCannotOverwriteANewProfile() = runTest {
        val dao = db.printerDao()
        val original = printer("a")
        dao.upsert(original)
        dao.upsert(printer("b"))
        dao.assign(PrinterAssignmentEntity("box", "a"))
        dao.assign(PrinterAssignmentEntity("pallet", "a"))
        dao.assign(PrinterAssignmentEntity("duplicate", "b"))
        val transport = object : PrinterTransport {
            override suspend fun status(printer: PrinterEntity) = PrinterStatus.NotReady(NotReadyReason.NO_PAPER)
            override suspend fun send(printer: PrinterEntity, document: ByteArray): SendOutcome = error("Must not send")
        }
        transport.statusRemembered(original, dao, db.recovery)
        assertEquals(listOf(PrintPurpose.BOX, PrintPurpose.PALLET), PrinterRouting(dao.all(), dao.observeAssignments().first()).attention)
        dao.upsert(original.copy(address = "new:9100", lastStatus = "ready"))
        transport.statusRemembered(original, dao, db.recovery)
        assertEquals("ready", dao.get("a")?.lastStatus)
    }

    @Test fun endpointNormalizationRecognizesTheSamePhysicalAddress() {
        assertEquals(printerEndpointKey(printer("a").copy(address = " HOST ")),
            printerEndpointKey(printer("b").copy(address = "host.:9100")))
        assertEquals(printerEndpointKey(printer("a").copy(transport = "bluetooth", address = "aa:bb:cc:dd:ee:ff")),
            printerEndpointKey(printer("b").copy(transport = "bluetooth", address = "AA:BB:CC:DD:EE:FF")))
    }

    @Test fun sameAddressOutputWaitsWithoutBlockingAnotherPrinter() = runTest {
        val firstEntered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val order = mutableListOf<String>()
        val first = async { PrinterOutput.serialized(printer("a")) { order += "a1"; firstEntered.complete(Unit); release.await() } }
        firstEntered.await()
        val second = async { PrinterOutput.serialized(printer("b").copy(address = "A:9100")) { order += "a2" } }
        val other = async { PrinterOutput.serialized(printer("c")) { order += "c" } }
        runCurrent()
        assertEquals(listOf("a1", "c"), order)
        release.complete(Unit)
        first.await(); second.await(); other.await()
        assertEquals(listOf("a1", "c", "a2"), order)
    }
}
