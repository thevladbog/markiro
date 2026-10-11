package app.markiro.handheld.core.label

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
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
    @Test fun offlineRenderWithNoCacheKeepsMandatoryLabelDataAndNeverFetchesBranding() = runTest {
        offline = true
        assertNull(branding.loadCached())
        assertEquals(0, requests)
        val spec = LabelSpecCodec.parse("""{"widthMm":75,"heightMm":120,"dpi":203,"language":"zpl","elements":[{"id":"logo","kind":"organization_logo","source":"organization","fallback":"markiro","xMm":4,"yMm":3,"widthMm":30,"heightMm":7},{"id":"sscc","kind":"barcode","xMm":4,"yMm":80,"format":"code128","data":"sscc","sizeMm":32,"moduleWidthMm":0.3754}]}""")
        val data = mapOf(LabelField.SSCC to "046012345600007778")
        val renderer = LabelRenderer(AndroidTextRasterizer(), branding)
        for (language in listOf(PrinterLanguage.ZPL, PrinterLanguage.TSPL)) {
            assertArrayEquals(renderer.render(spec.copy(elements=spec.elements.filterNot { it is LabelElement.OrganizationLogo }), data, language,203), renderer.render(spec,data,language,203))
        }
        assertEquals(0,requests)
    }
    @Test fun unchangedCompanyDescriptorReusesPixelsAndPrefsAndChangedDescriptorDownloadsAgain() = runTest {
        val bytes = javaClass.getResourceAsStream("/branding-company.webp")!!.use { it.readBytes() }
        val bitmap = android.graphics.BitmapFactory.decodeByteArray(bytes,0,bytes.size)
        val width=bitmap.width; val height=bitmap.height; bitmap.recycle()
        val checksum=java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        var revision="a1111111-1111-4111-8111-111111111111"
        var name="Before"
        var downloads=0
        val api = Proxy.newProxyInstance(StationApi::class.java.classLoader,arrayOf(StationApi::class.java)) { _,method,_ -> when(method.name) {
            "printBranding" -> Json.parseToJsonElement("""{"organizationName":"$name","logoRevision":"$revision","logoUrl":"/station/handheld-branding/logo/$revision","logo":{"contentType":"image/webp","byteSize":${bytes.size},"checksum":"$checksum","width":$width,"height":$height}}""") as kotlinx.serialization.json.JsonObject
            "printBrandingLogo" -> { downloads++; bytes.toResponseBody("image/webp".toMediaType()) }
            else -> error("unexpected ${method.name}")
        } } as StationApi
        val subject=OrganizationPrintBranding(context,db,api)
        val prefs=context.getSharedPreferences("print-branding-v1",Context.MODE_PRIVATE)
        var writes=0
        val listener=android.content.SharedPreferences.OnSharedPreferenceChangeListener { _,_ -> writes++ }
        prefs.registerOnSharedPreferenceChangeListener(listener)
        try {
            val first=subject.refresh()
            val saved=prefs.all.toMap()
            val writesBefore=writes
            name="After"
            assertEquals(first,subject.refresh())
            assertEquals(1,downloads)
            assertEquals(saved,prefs.all)
            assertEquals(writesBefore,writes)
            revision="b1111111-1111-4111-8111-111111111111"
            assertEquals(first,subject.refresh())
            assertEquals(2,downloads)
            assertNotEquals(saved,prefs.all)
        } finally { prefs.unregisterOnSharedPreferenceChangeListener(listener) }
    }

}
