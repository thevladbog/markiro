package app.markiro.handheld

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.host.HostLinkStatus
import app.markiro.handheld.feature.hub.HubScreen
import app.markiro.handheld.feature.hub.HubUi
import app.markiro.handheld.feature.settings.SettingsScreen
import app.markiro.handheld.feature.settings.SettingsUi
import app.markiro.handheld.feature.signin.RosterInfo
import app.markiro.handheld.feature.signin.SignInCallbacks
import app.markiro.handheld.feature.signin.SignInScreen
import app.markiro.handheld.feature.signin.SignInUi
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/** Native Compose captures for visual inspection; functional assertions live beside each feature. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "ru-w360dp-h640dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class HandheldRedesignVisualTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private fun capture(name: String) {
        compose.waitForIdle()
        val bitmap = compose.runOnIdle {
            val view = compose.activity.window.decorView
            Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888).also { view.draw(Canvas(it)) }
        }
        val folder = File("build/redesign-visuals").also { it.mkdirs() }
        File(folder, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
    @Test fun loginDark() {
        compose.setContent { MarkiroTheme { Box(Modifier.fillMaxSize().safeDrawingPadding()) {
            SignInScreen(SignInUi.Login(), SignInCallbacks(), RosterInfo(count = 12))
        } } }
        capture("login-dark-360")
    }
    @Test @Config(qualifiers = "ru-w320dp-h568dp-mdpi") fun loginLightSmall() {
        compose.setContent { MarkiroTheme(dark = false) { Box(Modifier.fillMaxSize().safeDrawingPadding()) {
            SignInScreen(SignInUi.Login("1024"), SignInCallbacks(), RosterInfo(count = 12))
        } } }
        capture("login-light-320")
    }
    @Test @Config(qualifiers = "ru-w320dp-h568dp-mdpi") fun hubSmall() {
        compose.setContent { MarkiroTheme { Box(Modifier.fillMaxSize().safeDrawingPadding()) {
            HubScreen(HubUi(organization = "РЕБЕЛ ЭППЛ", operatorName = "Богатырев Владислав Сергеевич", lineName = "Линия 1", hostMode = true, hostLink = HostLinkStatus.Online), {}, {})
        } } }
        capture("hub-dark-320")
    }
    @Test fun settingsLight() {
        compose.setContent { MarkiroTheme(dark = false) { Box(Modifier.fillMaxSize().safeDrawingPadding()) {
            SettingsScreen(SettingsUi(app.markiro.handheld.core.scan.ScanSourceKind.BUILTIN_INTENT, "honeywell", app.markiro.handheld.feature.settings.ThemeMode.LIGHT, "ru"), null, {}, {}, onTheme = {}, onLanguage = {})
        } } }
        capture("settings-light-360")
    }
    @Test fun templatePreviewDark() {
        val template = app.markiro.handheld.core.print.CachedLabelTemplate("box", "box", "Коробка 100×100",
            """{"widthMm":100,"heightMm":100,"dpi":203,"language":"zpl","elements":[{"kind":"field","id":"name","xMm":4,"yMm":4,"field":"product.name","fontSizePt":14},{"kind":"field","id":"qty","xMm":4,"yMm":20,"field":"qty","fontSizePt":12},{"kind":"barcode","id":"sscc","xMm":4,"yMm":35,"format":"code128","data":"sscc","sizeMm":30}]}""")
        compose.setContent { MarkiroTheme { Box(Modifier.fillMaxSize().safeDrawingPadding()) {
            app.markiro.handheld.feature.printer.PrinterTemplateChooserScreen(
                app.markiro.handheld.core.print.PrinterEntity("p", "TSC TE200", "wifi", "printer:9100", "zpl", 203, false, null, null),
                app.markiro.handheld.core.print.PrintPurpose.BOX,
                app.markiro.handheld.feature.printer.PrinterTemplatesUi(catalog = listOf(template), loading = false),
                {}, { _, _ -> }, {},
            )
        } } }
        compose.onNodeWithText("Коробка 100×100").performClick()
        compose.onNodeWithText("Далее").performScrollTo().performClick()
        capture("template-preview-dark-360")
    }

}
