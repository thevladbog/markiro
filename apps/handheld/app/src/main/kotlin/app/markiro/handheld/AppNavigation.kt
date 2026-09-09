package app.markiro.handheld

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.feature.hub.HubScreen
import app.markiro.handheld.feature.hub.HubTile
import app.markiro.handheld.feature.hub.HubViewModel
import app.markiro.handheld.feature.hub.RosterRefresher
import app.markiro.handheld.feature.pairing.PairingCallbacks
import app.markiro.handheld.feature.pairing.PairingScreen
import app.markiro.handheld.feature.pairing.PairingViewModel
import app.markiro.handheld.feature.settings.AppPreferences
import app.markiro.handheld.feature.settings.ComingSoonScreen
import app.markiro.handheld.feature.settings.ScannerSettingsScreen
import app.markiro.handheld.feature.settings.SettingsScreen
import app.markiro.handheld.feature.settings.SettingsViewModel
import app.markiro.handheld.feature.settings.ThemeMode
import app.markiro.handheld.feature.signin.SessionHolder
import app.markiro.handheld.feature.signin.SignInCallbacks
import app.markiro.handheld.feature.signin.SignInScreen
import app.markiro.handheld.feature.signin.SignInViewModel

object Routes {
    const val PAIRING = "pairing"
    const val SIGN_IN = "signin"
    const val HUB = "hub"
    const val SETTINGS = "settings"
    const val SCANNER = "settings/scanner"
    const val SOON = "soon/{title}"
    fun soon(title: String) = "soon/$title"
}

@Composable
fun MarkiroApp(shell: AppShellViewModel, session: SessionHolder, refresher: RosterRefresher, preferences: AppPreferences) {
    val start by shell.start.collectAsStateWithLifecycle()
    val dark = when (preferences.theme) {
        ThemeMode.DARK -> true
        ThemeMode.LIGHT -> false
        ThemeMode.SYSTEM -> isSystemInDarkTheme()
    }
    MarkiroTheme(dark = dark) {
        val first = start ?: return@MarkiroTheme
        val nav = rememberNavController()
        val sessionState by session.state.collectAsStateWithLifecycle()

        LaunchedEffect(Unit) {
            shell.events.collect { event ->
                when (event) {
                    ShellEvent.Revoked -> nav.navigate(Routes.PAIRING) { popUpTo(0) }
                    ShellEvent.Locked -> nav.navigate(Routes.SIGN_IN) { popUpTo(0) }
                }
            }
        }
        LaunchedEffect(sessionState.operator, sessionState.locked) {
            val route = nav.currentDestination?.route
            if (sessionState.operator != null && !sessionState.locked && route == Routes.SIGN_IN) {
                nav.navigate(Routes.HUB) { popUpTo(0) }
            }
            if (sessionState.operator == null && route != null && route !in setOf(Routes.SIGN_IN, Routes.PAIRING)) {
                nav.navigate(Routes.SIGN_IN) { popUpTo(0) }
            }
        }

        val startRoute = when (first) {
            StartDestination.PAIRING -> Routes.PAIRING
            StartDestination.SIGN_IN -> Routes.SIGN_IN
            StartDestination.HUB -> Routes.HUB
        }
        NavHost(nav, startDestination = startRoute) {
            composable(Routes.PAIRING) {
                val vm: PairingViewModel = hiltViewModel()
                val state by vm.state.collectAsStateWithLifecycle()
                PairingScreen(
                    state,
                    PairingCallbacks(
                        onDigit = vm::onDigit,
                        onBackspace = vm::onBackspace,
                        onConfirm = vm::onConfirm,
                        onServerUrl = vm::onServerUrl,
                        onRetry = vm::retry,
                        onDone = { nav.navigate(Routes.SIGN_IN) { popUpTo(0) } },
                    ),
                )
            }
            composable(Routes.SIGN_IN) {
                val vm: SignInViewModel = hiltViewModel()
                val state by vm.state.collectAsStateWithLifecycle()
                SignInScreen(
                    state,
                    SignInCallbacks(
                        onDigit = vm::onDigit,
                        onBackspace = vm::onBackspace,
                        onConfirm = vm::onConfirm,
                        onOpenSearch = vm::openSearch,
                        onSearchQuery = vm::onSearchQuery,
                        onPickOperator = vm::onPickOperator,
                        onBack = vm::back,
                        onSwitchOperator = vm::switchOperator,
                    ),
                )
            }
            composable(Routes.HUB) {
                val vm: HubViewModel = hiltViewModel()
                val state by vm.state.collectAsStateWithLifecycle()
                LaunchedEffect(Unit) {
                    refresher.refresh()
                    vm.refresh()
                }
                HubScreen(
                    state,
                    onTile = { tile ->
                        when (tile) {
                            HubTile.SHIFT -> nav.navigate(Routes.soon("Смена"))
                            HubTile.INVENTORY -> nav.navigate(Routes.soon("Инвентаризация"))
                            HubTile.CHECK -> nav.navigate(Routes.soon("Проверка кода"))
                            HubTile.SETTINGS -> nav.navigate(Routes.SETTINGS)
                        }
                    },
                    onSignOut = vm::signOut,
                )
            }
            composable(Routes.SETTINGS) {
                val vm: SettingsViewModel = hiltViewModel()
                val state by vm.state.collectAsStateWithLifecycle()
                val config by vm.config.collectAsStateWithLifecycle()
                SettingsScreen(
                    state,
                    config,
                    onBack = { nav.popBackStack() },
                    onScanner = { nav.navigate(Routes.SCANNER) },
                    onTheme = vm::setTheme,
                    onLanguage = vm::setLanguage,
                )
            }
            composable(Routes.SCANNER) {
                val vm: SettingsViewModel = hiltViewModel()
                val state by vm.state.collectAsStateWithLifecycle()
                ScannerSettingsScreen(
                    state,
                    onBack = { nav.popBackStack() },
                    onSource = vm::setSource,
                    onProfile = vm::setProfile,
                    onDebugScan = vm::submitDebugScan,
                )
            }
            composable(Routes.SOON) { entry ->
                ComingSoonScreen(entry.arguments?.getString("title") ?: "", onBack = { nav.popBackStack() })
            }
        }
    }
}
