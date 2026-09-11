package app.markiro.handheld.feature.shift

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.MainDispatcherRule
import app.markiro.handheld.core.box.SsccPool
import app.markiro.handheld.core.network.NetworkModule
import app.markiro.handheld.core.network.ReachabilityTracker
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory

@RunWith(AndroidJUnit4::class)
class ShiftListViewModelTest {
    @get:Rule
    val main = MainDispatcherRule()

    private lateinit var db: HandheldDatabase
    private lateinit var server: MockWebServer
    private lateinit var api: StationApi

    @Before
    fun setUp() = runTest {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        server = MockWebServer().also { it.start() }
        api = Retrofit.Builder().baseUrl(server.url("/")).client(OkHttpClient())
            .addConverterFactory(NetworkModule.json().asConverterFactory("application/json".toMediaType()))
            .build()
            .create(StationApi::class.java)
        db.deviceConfigDao().upsert(
            DeviceConfigEntity(
                deviceId = "dev-1", deviceName = "ТСД 1", tenantId = "t", organizationName = "ООО",
                lineId = "l1", lineName = "Линия 2", kind = "handheld", serverUrl = "http://x", pairedAt = 1L,
            ),
        )
    }

    @After
    fun tearDown() {
        try {
            main.cancelAndJoinModels()
        } finally {
            server.shutdown()
            db.close()
        }
    }

    private fun vm() = main.track(
        ShiftListViewModel(
            ShiftRepository(api, db, NetworkModule.json(), SsccPool(db)) { 1_757_500_000_000L },
            db.deviceConfigDao(),
            ReachabilityTracker { 1_757_500_000_000L },
            flowOf(Unit),
        ),
    )

    /**
     * `refreshList` has always reported whether it reached the server and the
     * view model has always thrown that away, so a refused refresh was
     * indistinguishable from a fresh list -- and the operator went on working
     * from yesterday's shifts.
     */
    @Test
    fun aRefusedRefreshIsCarriedIntoTheState() = runTest {
        server.enqueue(MockResponse().setResponseCode(503))
        assertTrue(vm().state.first { !it.loading }.refreshFailed)
    }

    @Test
    fun aSuccessfulRefreshLeavesNoWarning() = runTest {
        server.enqueue(MockResponse().setBody("""{"items":[]}"""))
        assertFalse(vm().state.first { !it.loading }.refreshFailed)
    }
}
