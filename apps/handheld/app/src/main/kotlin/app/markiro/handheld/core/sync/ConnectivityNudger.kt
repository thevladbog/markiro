package app.markiro.handheld.core.sync

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network

/** Calls back when any default network comes up so every sync engine can drain; failures to register are ignored. */
class ConnectivityNudger(private val context: Context, private val onAvailable: () -> Unit) {
    fun register() {
        val manager = context.getSystemService(ConnectivityManager::class.java) ?: return
        runCatching {
            manager.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) = onAvailable()
            })
        }
    }
}
