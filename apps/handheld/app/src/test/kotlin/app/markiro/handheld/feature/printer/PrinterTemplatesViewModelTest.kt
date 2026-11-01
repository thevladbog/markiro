package app.markiro.handheld.feature.printer

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.MainDispatcherRule
import app.markiro.handheld.core.network.NetworkModule
import app.markiro.handheld.core.print.PrintPurpose
import app.markiro.handheld.core.print.PrinterEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.RosterStore
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import app.markiro.handheld.feature.hub.RosterRefresher
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PrinterTemplatesViewModelTest {
    @get:Rule val main = MainDispatcherRule()
    private lateinit var db: HandheldDatabase

    @Before fun setUp() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        db.initializeRecoveryForTest()
    }

    @After fun tearDown() {
        try { main.cancelAndJoinModels() } finally { db.close() }
    }

    @Test fun saveMessageSurvivesReturningToProfileUntilAnotherChoiceBegins() = runTest(timeout = 10.seconds) {
        db.printerDao().upsert(PrinterEntity("p", "Printer", "wifi", "localhost:9100", "zpl", 203, false, null, null))
        val refresher = RosterRefresher(db.recovery,
            NetworkModule.stationApi(OkHttpClient(), NetworkModule.json()),
            RosterStore(db.operatorDao(), db.recovery), db.deviceConfigDao())
        val model = main.track(PrinterTemplatesViewModel(db, refresher))
        val chooser = backgroundScope.launch { model.state.collect() }
        model.state.first { !it.loading }
        model.save("p", PrintPurpose.BOX, null)
        model.state.first { it.saved }
        chooser.cancel()
        // A new subscriber models returning from the chooser to the printer profile.
        model.state.first { it.saved }
        model.beginChoice()
        val next = model.state.first { !it.saved }
        assertFalse(next.saveFailed)
        model.save("missing", PrintPurpose.BOX, null)
        model.state.first { it.saveFailed }
        model.beginChoice()
        assertFalse(model.state.first { !it.saveFailed }.saved)
    }
}
