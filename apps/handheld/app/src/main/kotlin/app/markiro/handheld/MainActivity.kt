package app.markiro.handheld

import android.os.Bundle
import android.view.KeyEvent
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.os.LocaleListCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import app.markiro.handheld.core.scan.ScanRouter
import app.markiro.handheld.feature.hub.RosterRefresher
import app.markiro.handheld.feature.settings.AppPreferences
import app.markiro.handheld.feature.signin.SessionHolder
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject

@AndroidEntryPoint
class MainActivity : AppCompatActivity() {
    @Inject lateinit var scanRouter: ScanRouter

    @Inject lateinit var session: SessionHolder

    @Inject lateinit var refresher: RosterRefresher

    @Inject lateinit var preferences: AppPreferences

    private val shell: AppShellViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        // Before `super`: this is what swaps the launch theme for the real one,
        // and it has to happen while the window is still being set up.
        installSplashScreen()
        super.onCreate(savedInstanceState)
        AppCompatDelegate.setApplicationLocales(LocaleListCompat.forLanguageTags(preferences.language))
        setContent { MarkiroApp(shell, session, refresher, preferences) }
        shell.onUserInteraction()
    }

    override fun onUserInteraction() {
        super.onUserInteraction()
        shell.onUserInteraction()
    }

    /** Keyboard-wedge scanners type into whatever is focused; intercept them before Compose does. */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean =
        scanRouter.wedge.onKeyEvent(event) || super.dispatchKeyEvent(event)
}
