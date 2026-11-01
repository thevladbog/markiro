package app.markiro.handheld.core.print

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PrintTemplateStoreTest {
    private lateinit var db: HandheldDatabase
    private lateinit var store: PrintTemplateStore
    private val a = """{"language":"zpl","widthMm":100,"heightMm":100,"dpi":203,"elements":[]}"""
    private val b = """{"language":"zpl","widthMm":100,"heightMm":150,"dpi":203,"elements":[]}"""
    @Before fun setup() = runTest {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java).allowMainThreadQueries().build()
        db.initializeRecoveryForTest()
        store = PrintTemplateStore(db)
        db.printerDao().upsert(PrinterEntity("p", "Printer", "wifi", "printer:9100", "zpl", 203, false, null, null))
        db.printerDao().assign(PrinterAssignmentEntity("box", "p"))
        store.cache(CachedLabelTemplate("a", "box", "Square", a))
        store.cache(CachedLabelTemplate("b", "box", "Tall", b))
    }
    @After fun close() = db.close()

    @Test fun closingKeepsTheAssignedDestinationBeforeAnyBytesArePrepared() = runTest {
        store.select("p", PrintPurpose.BOX, "a")
        store.freeze(PrintPurpose.BOX, "closed", a, "product")
        val other = db.printerDao().get("p")!!.copy(id = "other", address = "other:9100")
        db.printerDao().upsert(other)
        db.printerDao().assign(PrinterAssignmentEntity("box", "other"))
        assertEquals("p", db.printerDao().destination("box", "closed", "initial")?.printer?.id)
    }

    @Test fun confirmingAPreviewCannotSaveADifferentCatalogueRevision() = runTest {
        store.cache(CachedLabelTemplate("a", "box", "Changed", b))
        assertFalse(store.select("p", PrintPurpose.BOX, "a", expectedSpec = a))
        assertEquals(null, db.printTemplateDao().choice("p", "box"))
    }

    @Test fun changingTheChoiceCannotChangeAClosedJobsLayout() = runTest {
        assertTrue(store.select("p", PrintPurpose.BOX, "a"))
        assertEquals(a, store.freeze(PrintPurpose.BOX, "closed", b, "product").specJson)
        assertTrue(store.select("p", PrintPurpose.BOX, "b"))
        assertEquals(a, PrintTemplateStore(db).freeze(PrintPurpose.BOX, "closed", b, "product").specJson)
        assertEquals(b, store.freeze(PrintPurpose.BOX, "new", a, "product").specJson)
        assertTrue(store.select("p", PrintPurpose.BOX, null))
        assertEquals(a, store.freeze(PrintPurpose.BOX, "default", a, "product").specJson)
    }

    @Test fun pendingJobsWithoutAnOriginalTemplateNeverPickUpALaterOverride() = runTest {
        store.freeze(PrintPurpose.BOX, "pending", null, "product")
        store.select("p", PrintPurpose.BOX, "b")
        assertEquals(a, store.forPrint(PrintPurpose.BOX, "pending", a, "product").specJson)
    }

    @Test fun invalidWrongPurposeAndDuplicateChoicesAreRejectedWithoutChangingTheSavedChoice() = runTest {
        assertTrue(store.select("p", PrintPurpose.BOX, "a"))
        store.cache(CachedLabelTemplate("pallet", "pallet", "Pallet", b))
        store.cache(CachedLabelTemplate("invalid", "box", "Invalid", "{}"))
        assertFalse(store.select("p", PrintPurpose.BOX, "pallet"))
        assertFalse(store.select("p", PrintPurpose.BOX, "invalid"))
        assertFalse(store.select("missing", PrintPurpose.BOX, "a"))
        assertFalse(store.select("p", PrintPurpose.DUPLICATE, "a"))
        assertEquals(a, store.freeze(PrintPurpose.BOX, "job", b, "product").specJson)
    }

    @Test fun productBoundTemplatesCannotPrintAnotherProductsLabels() = runTest {
        store.cache(CachedLabelTemplate("scoped", "box", "Scoped", b, productId = "own"))
        store.select("p", PrintPurpose.BOX, "scoped")
        val refused = store.freeze(PrintPurpose.BOX, "wrong", a, "other")
        assertNull(refused.specJson)
        assertEquals("template_incompatible", refused.reason)
        assertEquals(b, store.freeze(PrintPurpose.BOX, "right", a, "own").specJson)
    }

    @Test fun narrowingAHostTemplateDoesNotChangeExistingJobsAndRefusesNewIncompatibleOnes() = runTest {
        store.select("p", PrintPurpose.BOX, "a")
        store.freeze(PrintPurpose.BOX, "old", b, "product", 9)
        store.cache(CachedLabelTemplate("a", "box", "Narrowed", b, groupCodes = "[1]"))
        assertEquals(a, store.forPrint(PrintPurpose.BOX, "old", b, "product", 9).specJson)
        assertEquals("template_incompatible", store.freeze(PrintPurpose.BOX, "new", a, "product", 9).reason)
        assertEquals(b, store.freeze(PrintPurpose.BOX, "matching", a, "product", 1).specJson)
    }
}
