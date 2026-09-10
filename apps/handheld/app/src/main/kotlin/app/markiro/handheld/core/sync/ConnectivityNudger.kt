package app.markiro.handheld.core.sync

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network

/** Nudges the engine when any default network comes up; failures to register are ignored. */
class ConnectivityNudger(private val context: Context, private val engine: SyncEngine) {
    fun register() {
        val manager = context.getSystemService(ConnectivityManager::class.java) ?: return
        runCatching {
            manager.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) = engine.nudge()
            })
        }
    }
}
