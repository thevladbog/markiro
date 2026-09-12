package app.markiro.handheld

import android.app.Application
import app.markiro.handheld.core.box.BoxRepository
import app.markiro.handheld.core.box.PalletRepository
import app.markiro.handheld.core.inventory.InventorySyncEngine
import app.markiro.handheld.core.sync.ConnectivityNudger
import app.markiro.handheld.core.sync.SyncEngine
import dagger.hilt.android.HiltAndroidApp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltAndroidApp
class HandheldApp : Application() {
    @Inject lateinit var syncEngine: SyncEngine

    @Inject lateinit var inventorySync: InventorySyncEngine

    @Inject lateinit var connectivity: ConnectivityNudger

    @Inject lateinit var boxes: BoxRepository

    @Inject lateinit var pallets: PalletRepository

    override fun onCreate() {
        super.onCreate()
        syncEngine.start()
        inventorySync.start()
        connectivity.register()
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch { demoteInterruptedPrints(boxes, pallets) }
    }
}

/**
 * Every label the app died in the middle of, of BOTH kinds.
 *
 * A print the app died in the middle of is unknown, never resumed: resuming
 * would be an automatic resend of a label that may already be on a box -- or,
 * since 06d, a pallet -- the server has accepted. Both printers persist
 * `printing` before handing bytes to the transport, so a row still in that
 * state at startup is one nothing will ever finish, and «Напечатать все» skips
 * only `unknown`: a stuck `printing` row would be resent in bulk.
 *
 * A top-level function rather than two statements inline so the startup
 * behaviour is exercisable by a test; `HandheldApp.onCreate` is its only caller.
 */
internal suspend fun demoteInterruptedPrints(boxes: BoxRepository, pallets: PalletRepository) {
    boxes.demoteInterruptedPrints()
    pallets.demoteInterruptedPrints()
}
