package app.markiro.handheld

import android.app.Application
import app.markiro.handheld.core.sync.ConnectivityNudger
import app.markiro.handheld.core.sync.SyncEngine
import dagger.hilt.android.HiltAndroidApp
import javax.inject.Inject

@HiltAndroidApp
class HandheldApp : Application() {
    @Inject lateinit var syncEngine: SyncEngine

    @Inject lateinit var connectivity: ConnectivityNudger

    override fun onCreate() {
        super.onCreate()
        syncEngine.start()
        connectivity.register()
    }
}
