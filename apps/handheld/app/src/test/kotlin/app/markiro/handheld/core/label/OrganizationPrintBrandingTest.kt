package app.markiro.handheld.core.label

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import app.markiro.handheld.core.storage.reconnectSameDeviceForTest
import java.lang.reflect.Proxy
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class OrganizationPrintBrandingTest {
    private lateinit var db: HandheldDatabase
    private lateinit var context: Context
    private lateinit var branding: OrganizationPrintBranding
    private var requests = 0
    private var offline = false
    private var configured = false
    private val absent = Json.parseToJsonElement("""{"logoRevision":null,"logoUrl":null,"logo":null}""").let { it as kotlinx.serialization.json.JsonObject }
    private val installed = Json.parseToJsonElement("""{"logoRevision":"a1111111-1111-4111-8111-111111111111","logoUrl":"/station/handheld-branding/logo/a1111111-1111-4111-8111-111111111111","logo":{"contentType":"image/webp","byteSize":20,"checksum":"0000000000000000000000000000000000000000000000000000000000000000","width":8,"height":4}}""").let { it as kotlinx.serialization.json.JsonObject }
    @Before fun open() {
        context = ApplicationProvider.getApplicationContext()
        context.getSharedPreferences("print-branding-v1", Context.MODE_PRIVATE).edit().clear().commit()
        db = Room.inMemoryDatabaseBuilder(context, HandheldDatabase::class.java).allowMainThreadQueries().build()
        db.initializeRecoveryForTest()
        val api = Proxy.newProxyInstance(StationApi::class.java.classLoader, arrayOf(StationApi::class.java)) { _, method, _ ->
            when (method.name) {
                "printBranding" -> { requests++; if (offline) error("offline"); if (configured) installed else absent }
                "printBrandingLogo" -> error("logo download failed")
                else -> error("Unexpected request ${method.name}")
            }
        } as StationApi
        branding = OrganizationPrintBranding(context, db, api)
    }
    @After fun close() { db.close() }
    @Test fun confirmedAbsenceUsesBundledLogoAndWorksOffline() = runTest {
        val first = branding.load()
        assertTrue(first.width > 0 && first.totalBytes > 0)
        offline = true
        assertEquals(first, branding.load())
        assertEquals(1, requests)
    }
    @Test fun configuredDownloadFailureNeverCreatesFallbackAndPreservesPriorCache() = runTest {
        configured = true
        assertTrue(runCatching { branding.load() }.isFailure)
        assertTrue(context.getSharedPreferences("print-branding-v1", Context.MODE_PRIVATE).all.isEmpty())
        configured = false
        val previous = branding.load()
        configured = true
        assertTrue(runCatching { branding.refresh() }.isFailure)
        offline = true
        assertEquals(previous, branding.load())
    }
    @Test fun credentialRotationCannotReusePreviousOwnerLogo() = runTest {
        branding.load()
        db.recovery.reject(db.recovery.token())
        db.reconnectSameDeviceForTest()
        offline = true
        assertTrue(runCatching { branding.load() }.isFailure)
        assertEquals(2, requests)
    }
}
