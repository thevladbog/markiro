package app.markiro.handheld

import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.runtime.remember
import androidx.navigation.NavBackStackEntry
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.navigation
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
import app.markiro.handheld.core.label.PrinterLanguage
import app.markiro.handheld.core.print.NotReadyReason
import app.markiro.handheld.feature.printer.AddPrinterCallbacks
import app.markiro.handheld.feature.printer.AddPrinterScreen
import app.markiro.handheld.feature.printer.BluetoothPairCallbacks
import app.markiro.handheld.feature.printer.BluetoothPairScreen
import app.markiro.handheld.feature.printer.PrinterErrorCallbacks
import app.markiro.handheld.feature.printer.PrinterErrorScreen
import app.markiro.handheld.feature.printer.PrinterListCallbacks
import app.markiro.handheld.feature.printer.PrinterListScreen
import app.markiro.handheld.feature.printer.PrinterViewModel
import app.markiro.handheld.feature.printer.TestPrintCallbacks
import app.markiro.handheld.feature.printer.TestPrintScreen
import app.markiro.handheld.feature.printer.TransportKind
import app.markiro.handheld.feature.settings.AppPreferences
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
import app.markiro.handheld.feature.work.BoxCloseCallbacks
import app.markiro.handheld.feature.work.BoxCloseScreen
import app.markiro.handheld.feature.work.BoxCloseStep
import app.markiro.handheld.feature.work.DuplicateCallbacks
import app.markiro.handheld.feature.work.DuplicateScreen
import app.markiro.handheld.feature.work.DuplicateStep
import app.markiro.handheld.feature.work.LabelQueueCallbacks
import app.markiro.handheld.feature.work.LabelQueueScreen
import app.markiro.handheld.feature.work.PlanReachedScreen
import app.markiro.handheld.feature.exceptions.DisassembleCallbacks
import app.markiro.handheld.feature.exceptions.DisassembleScreen
import app.markiro.handheld.feature.exceptions.DisassembleViewModel
import app.markiro.handheld.feature.exceptions.ExceptionsCallbacks
import app.markiro.handheld.feature.exceptions.ExceptionsScreen
import app.markiro.handheld.feature.exceptions.ExceptionsViewModel
import app.markiro.handheld.feature.exceptions.ReprintCallbacks
import app.markiro.handheld.feature.exceptions.ReprintScreen
import app.markiro.handheld.feature.exceptions.ReprintViewModel
import app.markiro.handheld.feature.work.LabelQueueViewModel
import app.markiro.handheld.feature.work.PalletCloseCallbacks
import app.markiro.handheld.feature.work.PalletCloseScreen
import app.markiro.handheld.feature.work.PalletCloseStep
import app.markiro.handheld.feature.work.WorkCallbacks
import app.markiro.handheld.feature.work.WorkScreen
import app.markiro.handheld.feature.work.WorkViewModel

object Routes {
    const val PAIRING = "pairing"
    const val SIGN_IN = "signin"
    const val HUB = "hub"
    const val SETTINGS = "settings"
    const val SCANNER = "settings/scanner"
    const val PRINTER_GRAPH = "settings/printer-graph"
    const val PRINTER = "settings/printer"
    const val PRINTER_ADD = "settings/printer/add"
    const val PRINTER_BLUETOOTH = "settings/printer/bluetooth"
    const val PRINTER_TEST = "settings/printer/test"
    const val SHIFTS = "shifts"
    const val WORK = "work/{shiftId}"
    const val CLOSE = "close/{shiftId}"
    const val CONFLICTS = "conflicts/{shiftId}"
    const val LABEL_QUEUE = "label-queue"
    const val EXCEPTIONS = "exceptions/{shiftId}"
    const val DISASSEMBLE = "exceptions/{shiftId}/disassemble"
    const val REPRINT = "exceptions/{shiftId}/reprint"
    const val INVENTORY = "inventory"
    const val INVENTORY_WORK = "inventory/{inventoryId}"
    const val INVENTORY_LEAVE = "inventory/{inventoryId}/leave"
    fun inventoryWork(id: String) = "inventory/$id"
    fun inventoryLeave(id: String) = "inventory/$id/leave"
    fun work(id: String) = "work/$id"
    fun close(id: String) = "close/$id"
    fun conflicts(id: String) = "conflicts/$id"
    fun exceptions(id: String) = "exceptions/$id"
    fun disassemble(id: String) = "exceptions/$id/disassemble"
    fun reprintLabel(id: String) = "exceptions/$id/reprint"
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
                            HubTile.SHIFT -> nav.navigate(Routes.SHIFTS)
                            HubTile.INVENTORY -> state.activeInventoryId?.let { nav.navigate(Routes.inventoryWork(it)) } ?: nav.navigate(Routes.INVENTORY)
                            HubTile.SETTINGS -> nav.navigate(Routes.SETTINGS)
                        }
                    },
                    onContinueShift = { nav.navigate(Routes.work(it)) },
                    onSignOut = vm::signOut,
                    onLabelQueue = { nav.navigate(Routes.LABEL_QUEUE) },
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
                // The view model outlives this composable: its back-stack entry
                // keeps it alive while the exception routes are on top. The
                // scanner is one app-wide flow, so it has to be told when the
                // work screen stops owning scans -- otherwise a box label
                // scanned to disassemble is recorded here as a bad code too.
                DisposableEffect(Unit) {
                    vm.setScanning(true)
                    onDispose { vm.setScanning(false) }
                }
                val state by vm.state.collectAsStateWithLifecycle()
                val closeStep by vm.closeStep.collectAsStateWithLifecycle()
                val palletCloseStep by vm.palletCloseStep.collectAsStateWithLifecycle()
                val duplicateStep by vm.duplicateStep.collectAsStateWithLifecycle()
                val planPrompt by vm.planPrompt.collectAsStateWithLifecycle()
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
                        onCloseBoxEarly = vm::closeEarly,
                        onLabelQueue = { nav.navigate(Routes.LABEL_QUEUE) },
                        onExceptions = { nav.navigate(Routes.exceptions(shiftId)) },
                        onRequestEarlyPalletClose = vm::requestEarlyPalletClose,
                        onConfirmEarlyPalletClose = vm::confirmEarlyPalletClose,
                        onCancelEarlyPalletClose = vm::cancelEarlyPalletClose,
                    ),
                )
                // Drawn over the work screen rather than as a route of its own, so
                // the fill grid underneath is not rebuilt between boxes.
                if (closeStep != BoxCloseStep.Idle) {
                    BoxCloseScreen(
                        closeStep,
                        BoxCloseCallbacks(
                            onRetry = vm::retryPrint,
                            onOtherPrinter = {
                                vm.deferLabel()
                                nav.navigate(Routes.PRINTER_GRAPH)
                            },
                            onDefer = vm::deferLabel,
                            onConfirmPrinted = vm::confirmPrinted,
                            onDismiss = vm::dismissClose,
                        ),
                    )
                }
                // Drawn AFTER the box's own overlay, so it takes the top of the
                // stack when a box that fills a pallet closes both at once: one
                // outcome for one scan (`CloseBox`'s own contract), rather than two
                // sequential confirmations. The box screen underneath is not lost --
                // once the pallet screen steps aside, an unresolved box print still
                // shows and still needs a person.
                if (palletCloseStep != PalletCloseStep.Idle) {
                    PalletCloseScreen(
                        palletCloseStep,
                        PalletCloseCallbacks(
                            onRetry = vm::retryPalletPrint,
                            onOtherPrinter = {
                                vm.deferPalletLabel()
                                nav.navigate(Routes.PRINTER_GRAPH)
                            },
                            onDefer = vm::deferPalletLabel,
                            onConfirmPrinted = vm::confirmPalletPrinted,
                            onDismiss = vm::dismissPalletClose,
                        ),
                    )
                }
                // Only the three states where a person has to decide. The ordinary
                // path stays in the last-scan zone, because a duplicate prints on
                // every unit and a takeover per scan would be unusable.
                if (duplicateStep != DuplicateStep.Idle) {
                    DuplicateScreen(
                        duplicateStep,
                        DuplicateCallbacks(
                            onRetry = vm::retryDuplicate,
                            onReprint = vm::reprintDuplicate,
                            onScanAgain = vm::dismissDuplicate,
                            onDismiss = vm::dismissDuplicate,
                        ),
                    )
                }
                // Last of the three overlays: a box close or a duplicate is about
                // the unit in the operator's hand and must win over a prompt about
                // the shift as a whole.
                if (planPrompt && closeStep == BoxCloseStep.Idle && duplicateStep == DuplicateStep.Idle) {
                    PlanReachedScreen(
                        total = state.total,
                        plan = state.plan ?: 0,
                        onClose = {
                            vm.dismissPlanPrompt()
                            nav.navigate(Routes.close(shiftId))
                        },
                        onContinue = vm::dismissPlanPrompt,
                    )
                }
            }
            composable(Routes.EXCEPTIONS) { entry ->
                val shiftId = entry.arguments?.getString("shiftId").orEmpty()
                val vm: ExceptionsViewModel = hiltViewModel()
                val state by vm.state.collectAsStateWithLifecycle()
                ExceptionsScreen(
                    state,
                    ExceptionsCallbacks(
                        onBack = { nav.popBackStack() },
                        onDisassemble = { nav.navigate(Routes.disassemble(shiftId)) },
                        onReprint = { nav.navigate(Routes.reprintLabel(shiftId)) },
                        onClear = vm::startClear,
                        onUndo = vm::startUndo,
                        onConfirm = vm::confirm,
                        onDismiss = vm::dismiss,
                    ),
                )
            }
            composable(Routes.DISASSEMBLE) {
                val vm: DisassembleViewModel = hiltViewModel()
                val step by vm.step.collectAsStateWithLifecycle()
                DisassembleScreen(
                    step,
                    DisassembleCallbacks(
                        onBack = { nav.popBackStack() },
                        onReason = vm::chooseReason,
                        onConfirm = vm::confirm,
                        onCancel = vm::cancel,
                        onDone = { nav.popBackStack() },
                    ),
                )
            }
            composable(Routes.REPRINT) {
                val vm: ReprintViewModel = hiltViewModel()
                val state by vm.state.collectAsStateWithLifecycle()
                ReprintScreen(
                    state,
                    ReprintCallbacks(
                        onBack = { nav.popBackStack() },
                        onChooseLast = vm::chooseLast,
                        onReason = vm::chooseReason,
                        onCancel = vm::cancel,
                        onDone = { nav.popBackStack() },
                    ),
                )
            }
            composable(Routes.LABEL_QUEUE) {
                val vm: LabelQueueViewModel = hiltViewModel()
                val state by vm.state.collectAsStateWithLifecycle()
                LabelQueueScreen(
                    state,
                    LabelQueueCallbacks(
                        onBack = { nav.popBackStack() },
                        onPrintOne = vm::printOne,
                        onPrintAll = vm::printAll,
                        onResolveUnknown = vm::resolveUnknown,
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
                // The system installer is an activity and the operator confirms it.
                val activity = LocalContext.current
                LaunchedEffect(vm) { vm.launchInstall.collect { activity.startActivity(it) } }
                val state by vm.state.collectAsStateWithLifecycle()
                val config by vm.config.collectAsStateWithLifecycle()
                SettingsScreen(
                    state,
                    config,
                    onBack = { nav.popBackStack() },
                    onScanner = { nav.navigate(Routes.SCANNER) },
                    onPrinter = { nav.navigate(Routes.PRINTER_GRAPH) },
                    onTheme = vm::setTheme,
                    onLanguage = vm::setLanguage,
                    onToggleSound = vm::toggleSound,
                    onVolume = vm::setVolume,
                    onToggleVibration = vm::toggleVibration,
                    onTest = vm::testSignal,
                    onCheckUpdate = vm::checkForUpdate,
                    onInstallUpdate = vm::installUpdate,
                )
            }
            navigation(startDestination = Routes.PRINTER, route = Routes.PRINTER_GRAPH) {
                composable(Routes.PRINTER) { entry ->
                    val vm = printerViewModel(nav, entry)
                    val state by vm.state.collectAsStateWithLifecycle()
                    PrinterListScreen(
                        state,
                        PrinterListCallbacks(
                            onBack = { nav.popBackStack() },
                            onSelect = vm::select,
                            onTest = {
                                vm.printTest()
                                nav.navigate(Routes.PRINTER_TEST)
                            },
                            onAdd = {
                                vm.startAdd(TransportKind.WIFI)
                                nav.navigate(Routes.PRINTER_ADD)
                            },
                        ),
                    )
                }
                composable(Routes.PRINTER_ADD) { entry ->
                    val vm = printerViewModel(nav, entry)
                    val form by vm.addForm.collectAsStateWithLifecycle()
                    // A saved printer leaves the form, which has nothing left to show, and lands on
                    // the list where the new row is already selected.
                    LaunchedEffect(vm) {
                        vm.saved.collect { nav.popBackStack(Routes.PRINTER, inclusive = false) }
                    }
                    // An unreachable printer gets its own screen; every other refusal stays on the form
                    // with the printer's own words.
                    if (form.error == NotReadyReason.UNREACHABLE) {
                        PrinterErrorScreen(
                            form.host,
                            PrinterErrorCallbacks(
                                onBack = { nav.popBackStack() },
                                onRetry = vm::checkAndSave,
                                onEdit = { vm.editHost(form.host) },
                            ),
                        )
                    } else {
                        AddPrinterScreen(
                            form,
                            AddPrinterCallbacks(
                                onBack = { nav.popBackStack() },
                                onTransport = vm::setTransport,
                                onHost = vm::editHost,
                                onPort = vm::editPort,
                                onLanguage = vm::setLanguage,
                                onDpi = vm::setDpi,
                                onCheck = vm::checkAndSave,
                                // The form has to know it went to Bluetooth, or backing out of
                                // pairing returns to a screen still asking for a network address.
                                onBluetooth = {
                                    vm.setTransport(TransportKind.BLUETOOTH)
                                    nav.navigate(Routes.PRINTER_BLUETOOTH)
                                },
                            ),
                        )
                    }
                }
                composable(Routes.PRINTER_BLUETOOTH) { entry ->
                    val vm = printerViewModel(nav, entry)
                    val state by vm.state.collectAsStateWithLifecycle()
                    LaunchedEffect(Unit) { vm.loadPairedDevices() }
                    BluetoothPairScreen(
                        state,
                        BluetoothPairCallbacks(
                            onBack = { nav.popBackStack() },
                            onGrant = { vm.loadPairedDevices() },
                            onSearchAgain = { vm.loadPairedDevices() },
                            onPick = { device ->
                                vm.pickPairedDevice(device)
                                nav.popBackStack(Routes.PRINTER, inclusive = false)
                            },
                        ),
                    )
                }
                composable(Routes.PRINTER_TEST) { entry ->
                    val vm = printerViewModel(nav, entry)
                    val step by vm.testStep.collectAsStateWithLifecycle()
                    val state by vm.state.collectAsStateWithLifecycle()
                    val printer = state.selected
                    TestPrintScreen(
                        step,
                        printer?.let { PrinterLanguage.fromWire(it.language) } ?: PrinterLanguage.ZPL,
                        printer?.dpi ?: 203,
                        TestPrintCallbacks(
                            onBack = {
                                vm.dismissTest()
                                nav.popBackStack()
                            },
                            onConfirm = {
                                vm.confirmTestPrinted()
                                nav.popBackStack()
                            },
                            onRetry = vm::retryTest,
                        ),
                    )
                }
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
        }
    }
}

/**
 * One view model for every printer destination. Each destination would otherwise get its own, so the
 * screen that prints and the screen that shows the outcome would watch different state and the test
 * print would appear to hang forever.
 */
@Composable
private fun printerViewModel(nav: NavHostController, entry: NavBackStackEntry): PrinterViewModel {
    val parent = remember(entry) { nav.getBackStackEntry(Routes.PRINTER_GRAPH) }
    return hiltViewModel(parent)
}
