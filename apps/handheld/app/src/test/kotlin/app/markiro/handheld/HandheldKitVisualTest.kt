package app.markiro.handheld

import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.WindowManager
import android.view.inspector.WindowInspector
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.Density
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.host.HostLinkStatus
import app.markiro.handheld.core.inventory.InventorySyncState
import app.markiro.handheld.core.storage.InventoryFixtures
import app.markiro.handheld.core.scan.ScanSourceKind
import app.markiro.handheld.core.sync.SyncState
import app.markiro.handheld.feature.hub.HubActiveShift
import app.markiro.handheld.feature.hub.HubScreen
import app.markiro.handheld.feature.hub.HubUi
import app.markiro.handheld.feature.inventory.InventoryProgress
import app.markiro.handheld.feature.inventory.InventoryWorkCallbacks
import app.markiro.handheld.feature.inventory.InventoryWorkScreen
import app.markiro.handheld.feature.inventory.InventoryWorkUi
import app.markiro.handheld.feature.pairing.HostPairingCallbacks
import app.markiro.handheld.feature.pairing.HostPairingScreen
import app.markiro.handheld.feature.pairing.HostPairingUi
import app.markiro.handheld.feature.printer.AddPrinterCallbacks
import app.markiro.handheld.feature.printer.AddPrinterForm
import app.markiro.handheld.feature.printer.AddPrinterScreen
import app.markiro.handheld.feature.reprint.SiteReprintCallbacks
import app.markiro.handheld.feature.reprint.SiteReprintScreen
import app.markiro.handheld.feature.reprint.SiteReprintStep
import app.markiro.handheld.feature.reprint.SiteReprintUi
import app.markiro.handheld.feature.settings.ScannerSettingsScreen
import app.markiro.handheld.feature.settings.SettingsScreen
import app.markiro.handheld.feature.settings.SettingsUi
import app.markiro.handheld.feature.settings.ThemeMode
import app.markiro.handheld.core.network.host.ShiftCreateOptionsDto
import app.markiro.handheld.core.network.host.ShiftCreateProductDto
import app.markiro.handheld.core.network.host.ShiftCreateTemplateDto
import app.markiro.handheld.feature.shift.CreateShiftCallbacks
import app.markiro.handheld.feature.shift.CreateShiftDraft
import app.markiro.handheld.feature.shift.CreateShiftMode
import app.markiro.handheld.feature.shift.CreateShiftScreen
import app.markiro.handheld.feature.shift.CreateShiftUi
import app.markiro.handheld.feature.shift.ShiftEntityFixtures
import app.markiro.handheld.feature.signin.SignInCallbacks
import app.markiro.handheld.feature.signin.SignInScreen
import app.markiro.handheld.feature.signin.SignInUi
import app.markiro.handheld.feature.work.WorkCallbacks
import app.markiro.handheld.feature.work.WorkScreen
import app.markiro.handheld.feature.work.WorkUi
import app.markiro.handheld.feature.work.BoxUi
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/** Real Compose views with synthetic state; these images do not exercise device hardware. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "ru-w360dp-h640dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class HandheldKitVisualTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val settings = SettingsUi(ScanSourceKind.BUILTIN_INTENT, "honeywell", ThemeMode.DARK, "ru")

    private fun captureThemes(name: String, scale: Float = 1f, onReady: () -> Unit = {}, onThemeReady: () -> Unit = {}, content: @Composable () -> Unit) {
        val dark = mutableStateOf(true)
        compose.setContent {
            val density = LocalDensity.current.density
            CompositionLocalProvider(LocalDensity provides Density(density, scale)) {
                MarkiroTheme(dark = dark.value) {
                    Box(Modifier.fillMaxSize().safeDrawingPadding()) { content() }
                }
            }
        }
        compose.waitForIdle()
        onReady()
        for (isDark in listOf(true, false)) {
            compose.runOnIdle { dark.value = isDark }
            compose.waitForIdle()
            onThemeReady()
            compose.waitForIdle()
            compose.runOnIdle {
                val view = compose.activity.window.decorView
                val overlays = WindowInspector.getGlobalWindowViews().filter { it !== view && it.isShown }
                // A dialog is captured as its own native window: Robolectric does not reproduce
                // device window-manager positioning. Popup menus retain their anchor coordinates.
                val dialog = overlays.lastOrNull {
                    val attributes = it.layoutParams as? WindowManager.LayoutParams
                    attributes != null && attributes.flags and WindowManager.LayoutParams.FLAG_DIM_BEHIND != 0
                }
                val target = dialog ?: view
                val bitmap = Bitmap.createBitmap(target.width, target.height, Bitmap.Config.ARGB_8888)
                val canvas = Canvas(bitmap)
                target.invalidate()
                target.draw(canvas)
                if (dialog == null) for (window in overlays) {
                    val location = IntArray(2)
                    window.getLocationOnScreen(location)
                    canvas.save()
                    canvas.translate(location[0].toFloat(), location[1].toFloat())
                    window.draw(canvas)
                    canvas.restore()
                }
                val folder = File("build/kit-visuals").also { it.mkdirs() }
                File(folder, "$name-${if (isDark) "dark" else "light"}.png").outputStream().use {
                    bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
                }
                bitmap.recycle()
            }
        }
    }

    @Test fun login() = captureThemes("login-360") {
        SignInScreen(SignInUi.Login("1024"), SignInCallbacks())
    }

    @Test @Config(qualifiers = "ru-w320dp-h520dp-mdpi")
    fun loginShortLargeText() = captureThemes("login-320-large", 1.5f) {
        SignInScreen(SignInUi.Login("1024"), SignInCallbacks())
    }

    @Test fun hub() = captureThemes("hub-360") {
        HubScreen(HubUi(organization = "РЕБЕЛ ЭППЛ", operatorName = "Анна Кузнецова", lineName = "Линия 1",
            hostMode = true, hostLink = HostLinkStatus.Online), {}, {})
    }

    @Test @Config(qualifiers = "ru-w320dp-h520dp-mdpi")
    fun activeShiftOffline() = captureThemes("hub-active-offline-320") {
        val shift = ShiftEntityFixtures.bundled("audit-shift")
        HubScreen(HubUi(organization = "РЕБЕЛ ЭППЛ", operatorName = "Анна Кузнецова", lineName = "Линия 1",
            activeShiftId = shift.id, activeShift = HubActiveShift(shift, 128, shared = true, staleAtMillis = 1L),
            hostMode = true, hostLink = HostLinkStatus.Offline, queue = 12), {}, {})
    }

    @Test fun settings() = captureThemes("settings-360") {
        SettingsScreen(settings, null, {}, {}, onTheme = {}, onLanguage = {})
    }

    @Test fun scanner() = captureThemes("scanner-360") {
        ScannerSettingsScreen(settings, {}, {}, {}, {})
    }

    @Test fun pairing() = captureThemes("pairing-360") {
        HostPairingScreen(HostPairingUi.Enter("192.168.1.10", ""), HostPairingCallbacks())
    }

    @Test fun printer() = captureThemes("printer-360") {
        AddPrinterScreen(AddPrinterForm(name = "TSC у линии 1", host = "192.168.1.50"), AddPrinterCallbacks())
    }

    @Test fun reprintReason() = captureThemes("reprint-reason-360") {
        SiteReprintScreen(SiteReprintUi(step = SiteReprintStep.REASON), SiteReprintCallbacks())
    }

    @Test fun work() = captureThemes("work-360") {
        WorkScreen(WorkUi(shift = ShiftEntityFixtures.bundled("audit-shift"), last = null,
            total = 128, plan = 1200, thisTerminal = 128, errors = 1, duplicates = 2,
            feed = emptyList(), sync = SyncState(pending = 0), reachable = true, team = null), WorkCallbacks())
    }

    @Test @Config(qualifiers = "ru-w320dp-h520dp-mdpi")
    fun workShortLargeText() = captureThemes("work-320-large", 1.5f) {
        WorkScreen(WorkUi(shift = ShiftEntityFixtures.bundled("audit-shift"), last = null,
            total = 128, plan = 1200, thisTerminal = 128, errors = 1, duplicates = 2,
            feed = emptyList(), sync = SyncState(pending = 12), reachable = false, team = null), WorkCallbacks())
    }

    @Test @Config(qualifiers = "ru-w320dp-h520dp-mdpi")
    fun createShiftWithPalletsOnShortScreen() = captureThemes("new-shift-320", onThemeReady = {
        compose.onNodeWithText("Создать и открыть").assertIsDisplayed()
    }) {
        val product = ShiftCreateProductDto("kefir", "Кефир 2,5%, 930 г", "04600682000020", 8, 12, 30)
        val options = ShiftCreateOptionsDto(
            lineId = "mobile", lineName = "Мобильная линия", timeZone = "Europe/Moscow",
            palletsAllowed = true, creationAllowed = true, products = listOf(product),
            templates = listOf(
                ShiftCreateTemplateDto("box", "Термо 75 × 120 мм", "box", null),
                ShiftCreateTemplateDto("pallet", "Термо 100 × 150 мм", "pallet", null),
            ),
        )
        val draft = CreateShiftDraft(mode = CreateShiftMode.PALLETS, plannedDate = "2026-11-12",
            productionDate = "2026-11-11", plan = "360").withProduct(product)
        CreateShiftScreen(CreateShiftUi(options = options, draft = draft, busy = false), CreateShiftCallbacks())
    }

    @Test fun inventoryOffline() = captureThemes("inventory-offline-360") {
        InventoryWorkScreen(InventoryWorkUi(task = InventoryFixtures.task("audit-inventory"),
            expectedCount = 4116, activeDate = "2026-08-20", last = null,
            progress = InventoryProgress(verified = 1240, discrepancies = 7, protected = 3, thisTerminal = 312, rejected = 1),
            feed = emptyList(), sync = InventorySyncState(pending = 37), reachable = false,
            held = null, closed = false), InventoryWorkCallbacks())
    }

    @Test fun connectionDetails() = captureThemes("connection-details-360", onReady = {
        compose.onNodeWithContentDescription("Связь и очередь").performClick()
    }) {
        HubScreen(HubUi(hostMode = true, hostLink = HostLinkStatus.Offline, queue = 12), {}, {})
    }

    @Test fun printerOutputChoices() = captureThemes("printer-output-choices-360", onReady = {
        compose.onNodeWithText("Обычная печать").performScrollTo().performClick()
    }) {
        AddPrinterScreen(AddPrinterForm(name = "TSC у линии 1", host = "192.168.1.50", outputMode = "normal"), AddPrinterCallbacks())
    }

    private fun aggregation(capacity: Int) = captureThemes("aggregation-$capacity-360") {
        WorkScreen(WorkUi(shift = ShiftEntityFixtures.bundled("audit-shift").copy(mode = "aggregation",
            boxCapacity = capacity, ssccIssuerPrefix = "046006820"), last = null,
            total = 128, plan = 1200, thisTerminal = 128, errors = 0, duplicates = 0,
            feed = emptyList(), sync = SyncState(pending = 0), reachable = true, team = null,
            box = BoxUi(ordinal = 1, filled = 7, capacity = capacity)), WorkCallbacks())
    }

    @Test fun aggregationSquaresRemain() = aggregation(12)
    @Test fun largeBoxKeepsTheCounterFallback() = aggregation(120)
    private val longProduct = "Сидр полусухой газированный «ДИКИЙ КРЕСТ» яблочный, пастеризованный, 0,45 л"

    private fun longProductWork(grid: Boolean, scale: Float) = captureThemes(
        "long-product-${if (grid) "aggregation" else "work"}-320${if (scale > 1f) "-large" else ""}", scale,
    ) {
        WorkScreen(WorkUi(shift = ShiftEntityFixtures.bundled("audit-long").copy(
            productName = longProduct, productPrintName = longProduct,
            mode = if (grid) "aggregation" else "validation", ssccIssuerPrefix = "046006820"),
            last = null, total = 128, plan = 1200, thisTerminal = 128, errors = 0, duplicates = 0,
            feed = emptyList(), sync = SyncState(pending = 0), reachable = true, team = null,
            box = if (grid) BoxUi(1, 7, 12) else null), WorkCallbacks())
    }

    @Test @Config(qualifiers = "ru-w320dp-h520dp-mdpi")
    fun threeLineWork() = longProductWork(false, 1f)
    @Test @Config(qualifiers = "ru-w320dp-h520dp-mdpi")
    fun threeLineAggregation() = longProductWork(true, 1f)
    @Test @Config(qualifiers = "ru-w320dp-h520dp-mdpi")
    fun longWorkLargeFont() = longProductWork(false, 1.5f)
    @Test @Config(qualifiers = "ru-w320dp-h520dp-mdpi")
    fun longAggregationLargeFont() = longProductWork(true, 1.5f)

    private fun longProductInventory(scale: Float) = captureThemes("long-product-inventory-320${if (scale > 1f) "-large" else ""}", scale) {
        InventoryWorkScreen(InventoryWorkUi(task = InventoryFixtures.task("audit-long-inventory").copy(productName = longProduct, productPrintName = longProduct),
            expectedCount = 1200, activeDate = null, last = null,
            progress = InventoryProgress(verified = 128, discrepancies = 0, protected = 0, thisTerminal = 128, rejected = 0),
            feed = emptyList(), sync = InventorySyncState(pending = 0), reachable = true,
            held = null, closed = false), InventoryWorkCallbacks())
    }
    @Test @Config(qualifiers = "ru-w320dp-h520dp-mdpi")
    fun threeLineInventory() = longProductInventory(1f)
    @Test @Config(qualifiers = "ru-w320dp-h520dp-mdpi")
    fun longInventoryLargeFont() = longProductInventory(1.5f)

    private fun longActiveCard(scale: Float, showAction: Boolean = false) = captureThemes("active-card-long-320${if (scale > 1f) "-large" else ""}${if (showAction) "-action" else ""}", scale, onThemeReady = {
        // Re-anchor the scrolled viewport after each theme has measured its content.
        if (showAction) compose.onNodeWithText("Продолжить").performScrollTo()
    }) {
        val shift = ShiftEntityFixtures.bundled("audit-card").copy(productName = longProduct, productPrintName = longProduct, plannedQty = 100)
        HubScreen(HubUi(organization = "РЕБЕЛ ЭППЛ", operatorName = "Анна Кузнецова", lineName = "Линия 1",
            activeShiftId = shift.id, activeShift = HubActiveShift(shift, 128, shared = true, staleAtMillis = 1L),
            hostMode = true, hostLink = HostLinkStatus.Offline, queue = 12), {}, {})
    }
    @Test @Config(qualifiers = "ru-w320dp-h640dp-mdpi")
    fun activeCardLongProduct() = longActiveCard(1f)
    @Test @Config(qualifiers = "ru-w320dp-h520dp-mdpi")
    fun activeCardLongProductLargeFont() = longActiveCard(1.5f)
    @Test @Config(qualifiers = "ru-w320dp-h520dp-mdpi")
    fun activeCardLargeFontActionAfterScroll() = longActiveCard(1.5f, showAction = true)

}
