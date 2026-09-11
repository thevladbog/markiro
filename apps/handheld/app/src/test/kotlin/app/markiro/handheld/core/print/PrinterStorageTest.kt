package app.markiro.handheld.core.print

import app.markiro.handheld.core.storage.initializeRecoveryForTest
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.storage.HandheldDatabase
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PrinterStorageTest {
    private lateinit var db: HandheldDatabase

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        db.initializeRecoveryForTest()
    }

    @After
    fun tearDown() = db.close()

    private fun printer(id: String, selected: Boolean = false) = PrinterEntity(
        id = id, name = "Zebra $id", transport = "wifi", address = "192.168.1.40:9100",
        language = "zpl", dpi = 203, selected = selected, lastStatus = null, lastSeenAt = null,
    )

    @Test
    fun selectingOnePrinterDeselectsTheOthers() = runTest {
        val dao = db.printerDao()
        dao.upsert(printer("a", selected = true))
        dao.upsert(printer("b"))
        assertEquals("a", dao.selected()?.id)
        dao.select("b")
        assertEquals("b", dao.selected()?.id)
        assertEquals(listOf(false, true), dao.all().sortedBy { it.id }.map { it.selected })
    }

    @Test
    fun deletingTheSelectedPrinterLeavesNoneSelected() = runTest {
        val dao = db.printerDao()
        dao.upsert(printer("a", selected = true))
        dao.delete("a")
        assertNull(dao.selected())
        assertEquals(emptyList<PrinterEntity>(), dao.observeAll().first())
    }

    @Test
    fun statusIsRecordedWithItsTimestamp() = runTest {
        val dao = db.printerDao()
        dao.upsert(printer("a", selected = true))
        dao.setStatus("a", "ready", 1_757_000_000_000L)
        assertEquals("ready", dao.selected()?.lastStatus)
        assertEquals(1_757_000_000_000L, dao.selected()?.lastSeenAt)
    }
}
