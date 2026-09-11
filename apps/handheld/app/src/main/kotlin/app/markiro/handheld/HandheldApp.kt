package app.markiro.handheld

import android.app.Application
import app.markiro.handheld.core.box.BoxRepository
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

    override fun onCreate() {
        super.onCreate()
        syncEngine.start()
        inventorySync.start()
        connectivity.register()
        // A print the app died in the middle of is unknown, never resumed:
        // resuming would be an automatic resend of a label that may already be on
        // a box the server has accepted.
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch { boxes.demoteInterruptedPrints() }
    }
}
