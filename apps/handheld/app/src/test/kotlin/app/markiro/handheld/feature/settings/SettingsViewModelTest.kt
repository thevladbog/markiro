package app.markiro.handheld.feature.settings

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.MainDispatcherRule
import app.markiro.handheld.core.inventory.InventorySyncEngine
import app.markiro.handheld.core.print.PrintPurpose
import app.markiro.handheld.core.print.PrinterAssignmentEntity
import app.markiro.handheld.core.print.PrinterEntity
import app.markiro.handheld.core.scan.ScanPreferences
import app.markiro.handheld.core.scan.ScanRouter
import app.markiro.handheld.core.signal.Signaller
import app.markiro.handheld.core.signal.TonePlayer
import app.markiro.handheld.core.signal.Wave
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import app.markiro.handheld.core.sync.SyncDriver
import app.markiro.handheld.core.sync.SyncState
import app.markiro.handheld.core.sync.SyncTransport
import app.markiro.handheld.core.update.UpdateCheck
import app.markiro.handheld.core.update.UpdateInstaller
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SettingsViewModelTest {
    @get:Rule val main = MainDispatcherRule()
    private lateinit var db: HandheldDatabase
    private val config = DeviceConfigEntity(
        deviceId = "dev", deviceName = "TSD", tenantId = "t", organizationName = "Factory",
        lineId = null, lineName = null, kind = "handheld", serverUrl = "https://unused.test", pairedAt = 1L,
    )

    @Before fun setUp() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        db.initializeRecoveryForTest()
    }

    @After fun tearDown() {
        try { main.cancelAndJoinModels() } finally { db.close() }
    }

    @Test fun printerPurposesFollowBackendChangesAndExcludeHostDuplicates() = runTest(timeout = 10.seconds) {
        db.deviceConfigDao().upsert(config)
        db.printerDao().upsert(PrinterEntity("p", "Printer", "wifi", "localhost:9100", "zpl", 203, false, "no_paper", null))
        db.printerDao().assign(PrinterAssignmentEntity("duplicate", "p"))
        val context = ApplicationProvider.getApplicationContext<Context>()
        val scan = ScanPreferences(context)
        val router = ScanRouter(context, scan)
        val app = AppPreferences(context)
        val client = OkHttpClient()
        val meta = MetaStore(db)
        val sync = object : SyncDriver {
            override val state = MutableStateFlow(SyncState())
            override suspend fun drainAll() = true
            override fun nudge() = Unit
            override fun start() = Unit
        }
        val inventory = InventorySyncEngine(db, meta, db.deviceConfigDao(),
            SyncTransport(client) { "https://unused.test" }, Json, backgroundScope)
        val model = main.track(SettingsViewModel(scan, router, router, app, db.deviceConfigDao(),
            Signaller(app, object : TonePlayer {
                override fun play(hz: Double, millis: Int, wave: Wave, volume: Float) = Unit
            }, null), sync, inventory, meta, db.printerDao(), UpdateCheck(client, Json), UpdateInstaller(context, client)))

        val cloud = model.state.first { it.missingPrinterPurposes != null }
        assertEquals(listOf(PrintPurpose.BOX, PrintPurpose.PALLET), cloud.missingPrinterPurposes)
        assertEquals(listOf(PrintPurpose.DUPLICATE), cloud.printerAttentionPurposes)
        assertEquals(3, cloud.printerPurposeCount)

        db.deviceConfigDao().upsert(config.copy(backend = "host"))
        val host = model.state.first { it.printerPurposeCount == 2 }
        assertEquals(listOf(PrintPurpose.BOX, PrintPurpose.PALLET), host.missingPrinterPurposes)
        assertEquals(emptyList<PrintPurpose>(), host.printerAttentionPurposes)
        for (purpose in listOf(PrintPurpose.BOX, PrintPurpose.PALLET)) {
            db.printerDao().assign(PrinterAssignmentEntity(purpose.wire, "p"))
        }
        val configured = model.state.first { it.missingPrinterPurposes?.isEmpty() == true }
        assertEquals(listOf(PrintPurpose.BOX, PrintPurpose.PALLET), configured.printerAttentionPurposes)
        db.printerDao().assign(PrinterAssignmentEntity("duplicate", null))
        db.deviceConfigDao().upsert(config)
        val cloudAgain = model.state.first { it.printerPurposeCount == 3 }
        assertEquals(listOf(PrintPurpose.DUPLICATE), cloudAgain.missingPrinterPurposes)
    }
}
