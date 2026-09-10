package app.markiro.handheld

import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
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
import app.markiro.handheld.feature.inventory.InventoryLeaveScreen
import app.markiro.handheld.feature.inventory.InventoryLeaveViewModel
import app.markiro.handheld.feature.inventory.InventoryListCallbacks
import app.markiro.handheld.feature.inventory.InventoryListEvent
import app.markiro.handheld.feature.inventory.InventoryListScreen
import app.markiro.handheld.feature.inventory.InventoryListViewModel
import app.markiro.handheld.feature.inventory.InventoryWorkCallbacks
import app.markiro.handheld.feature.inventory.InventoryWorkScreen
import app.markiro.handheld.feature.inventory.InventoryWorkViewModel
import app.markiro.handheld.feature.pairing.PairingCallbacks
import app.markiro.handheld.feature.pairing.PairingScreen
import app.markiro.handheld.feature.pairing.PairingViewModel
import app.markiro.handheld.feature.settings.AppPreferences
import app.markiro.handheld.feature.settings.ComingSoonScreen
import app.markiro.handheld.feature.settings.ScannerSettingsScreen
import app.markiro.handheld.feature.settings.SettingsScreen
import app.markiro.handheld.feature.settings.SettingsViewModel
import app.markiro.handheld.feature.settings.ThemeMode
import app.markiro.handheld.feature.shift.CloseCallbacks
import app.markiro.handheld.feature.shift.CloseScreen
import app.markiro.handheld.feature.shift.CloseViewModel
import app.markiro.handheld.feature.shift.ShiftListCallbacks
import app.markiro.handheld.feature.shift.ShiftListEvent
import app.markiro.handheld.feature.shift.ShiftListScreen
import app.markiro.handheld.feature.shift.ShiftListViewModel
import app.markiro.handheld.feature.signin.SessionHolder
import app.markiro.handheld.feature.signin.SignInCallbacks
import app.markiro.handheld.feature.signin.SignInScreen
import app.markiro.handheld.feature.signin.SignInViewModel
import app.markiro.handheld.feature.work.ConflictsScreen
import app.markiro.handheld.feature.work.ConflictsViewModel
import app.markiro.handheld.feature.work.WorkCallbacks
import app.markiro.handheld.feature.work.WorkScreen
import app.markiro.handheld.feature.work.WorkViewModel

object Routes {
    const val PAIRING = "pairing"
    const val SIGN_IN = "signin"
    const val HUB = "hub"
    const val SETTINGS = "settings"
    const val SCANNER = "settings/scanner"
    const val SHIFTS = "shifts"
    const val WORK = "work/{shiftId}"
    const val CLOSE = "close/{shiftId}"
    const val CONFLICTS = "conflicts/{shiftId}"
    const val SOON = "soon/{tile}"
    const val INVENTORY = "inventory"
    const val INVENTORY_WORK = "inventory/{inventoryId}"
    const val INVENTORY_LEAVE = "inventory/{inventoryId}/leave"
    fun inventoryWork(id: String) = "inventory/$id"
    fun inventoryLeave(id: String) = "inventory/$id/leave"
    fun work(id: String) = "work/$id"
    fun close(id: String) = "close/$id"
    fun conflicts(id: String) = "conflicts/$id"
    fun soon(tile: HubTile) = "soon/${tile.name}"
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
        NavHost(
            nav,
            startDestination = startRoute,
            // API 35 draws edge-to-edge; keep every screen below the status bar and above the gesture area.
            modifier = Modifier.fillMaxSize().background(MarkiroTheme.colors.surfacePage).safeDrawingPadding(),
        ) {
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
                            HubTile.SHIFT -> state.activeShiftId?.let { nav.navigate(Routes.work(it)) } ?: nav.navigate(Routes.SHIFTS)
                            HubTile.INVENTORY -> state.activeInventoryId?.let { nav.navigate(Routes.inventoryWork(it)) } ?: nav.navigate(Routes.INVENTORY)
                            HubTile.CHECK -> nav.navigate(Routes.soon(tile))
                            HubTile.SETTINGS -> nav.navigate(Routes.SETTINGS)
                        }
                    },
                    onSignOut = vm::signOut,
                )
            }
            composable(Routes.SHIFTS) {
                val vm: ShiftListViewModel = hiltViewModel()
                val state by vm.state.collectAsStateWithLifecycle()
                LaunchedEffect(Unit) {
                    vm.events.collect { event ->
                        when (event) {
                            is ShiftListEvent.Entered -> nav.navigate(Routes.work(event.shiftId)) { popUpTo(Routes.HUB) }
                        }
                    }
                }
                ShiftListScreen(
                    state,
                    ShiftListCallbacks(
                        onBack = { nav.popBackStack() },
                        onContinue = vm::continueCurrent,
                        onSelect = vm::select,
                        onExpandOthers = vm::expandOthers,
                        onSelectOther = vm::selectOther,
                        onConfirmOther = vm::confirmOther,
                        onDismiss = vm::dismissDialog,
                        onRefresh = vm::refresh,
                    ),
                )
            }
            composable(Routes.WORK) { entry ->
                val vm: WorkViewModel = hiltViewModel()
                val state by vm.state.collectAsStateWithLifecycle()
                val shiftId = entry.arguments?.getString("shiftId").orEmpty()
                WorkScreen(
                    state,
                    WorkCallbacks(
                        onLeave = {
                            vm.leave()
                            nav.popBackStack(Routes.HUB, inclusive = false)
                        },
                        onClose = { nav.navigate(Routes.close(shiftId)) },
                        onConflicts = { nav.navigate(Routes.conflicts(shiftId)) },
                    ),
                )
            }
            composable(Routes.CLOSE) {
                val vm: CloseViewModel = hiltViewModel()
                val step by vm.step.collectAsStateWithLifecycle()
                CloseScreen(
                    step,
                    CloseCallbacks(
                        onConfirm = vm::confirm,
                        onCancel = { nav.popBackStack() },
                        onSelectReason = vm::selectReason,
                        onSubmitReason = vm::submitReason,
                        onDone = { nav.navigate(Routes.HUB) { popUpTo(Routes.HUB) { inclusive = true } } },
                    ),
                )
            }
            composable(Routes.CONFLICTS) {
                val vm: ConflictsViewModel = hiltViewModel()
                val rows by vm.rows.collectAsStateWithLifecycle()
                ConflictsScreen(rows, onBack = { nav.popBackStack() })
            }
            composable(Routes.INVENTORY) {
                val vm: InventoryListViewModel = hiltViewModel()
                val state by vm.state.collectAsStateWithLifecycle()
                LaunchedEffect(Unit) {
                    vm.events.collect { event ->
                        when (event) {
                            is InventoryListEvent.Entered -> nav.navigate(Routes.inventoryWork(event.inventoryId)) { popUpTo(Routes.HUB) }
                        }
                    }
                }
                InventoryListScreen(
                    state,
                    InventoryListCallbacks(
                        onBack = { nav.popBackStack() },
                        onContinue = vm::continueActive,
                        onSelect = vm::select,
                        onExpandOthers = vm::expandOthers,
                        onConfirmOther = vm::confirmOther,
                        onDismiss = vm::dismissDialog,
                        onRetry = vm::retry,
                        onRefresh = vm::refresh,
                    ),
                )
            }
            composable(Routes.INVENTORY_WORK) { entry ->
                val vm: InventoryWorkViewModel = hiltViewModel()
                val state by vm.state.collectAsStateWithLifecycle()
                val id = entry.arguments?.getString("inventoryId").orEmpty()
                InventoryWorkScreen(
                    state,
                    InventoryWorkCallbacks(
                        onLeave = { nav.navigate(Routes.inventoryLeave(id)) },
                        onToHub = { nav.navigate(Routes.HUB) { popUpTo(Routes.HUB) { inclusive = true } } },
                        onApplyDate = vm::applyDateAndAccept,
                        onAcceptAsIs = vm::acceptAsIs,
                        onSkip = vm::skipHeld,
                        onSetDate = vm::setDate,
                    ),
                )
            }
            composable(Routes.INVENTORY_LEAVE) {
                val vm: InventoryLeaveViewModel = hiltViewModel()
                val step by vm.step.collectAsStateWithLifecycle()
                InventoryLeaveScreen(
                    step,
                    onDone = { nav.navigate(Routes.HUB) { popUpTo(Routes.HUB) { inclusive = true } } },
                    onBack = { nav.popBackStack() },
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
                    onToggleSound = vm::toggleSound,
                    onVolume = vm::setVolume,
                    onToggleVibration = vm::toggleVibration,
                    onTest = vm::testSignal,
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
                val title = when (entry.arguments?.getString("tile")) {
                    HubTile.SHIFT.name -> R.string.hub_tile_shift
                    else -> R.string.hub_tile_check
                }
                ComingSoonScreen(stringResource(title), onBack = { nav.popBackStack() })
            }
        }
    }
}
