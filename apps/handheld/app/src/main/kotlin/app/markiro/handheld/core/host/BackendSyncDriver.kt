package app.markiro.handheld.core.host

import app.markiro.handheld.core.storage.DeviceConfigDao
import app.markiro.handheld.core.sync.SyncDriver
import app.markiro.handheld.core.sync.SyncEngine
import app.markiro.handheld.core.sync.SyncState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn

/**
 * The driver the consumers hold: each call goes to the engine of this device's backend, read from `device_config` at the call (a device
 * not paired yet is the cloud's, as it always was). Both loops are started, and each refuses a device that is not its own: the host's
 * engine does nothing for a cloud device, and a cloud call on a host device is stopped by the backend guard of the cloud client.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class BackendSyncDriver(
    private val config: DeviceConfigDao,
    private val cloud: SyncEngine,
    private val host: HostSyncEngine,
    scope: CoroutineScope,
) : SyncDriver {
    private suspend fun isHost(): Boolean = config.get()?.backend == "host"

    override val state: StateFlow<SyncState> = config.observe()
        .map { it?.backend == "host" }
        .distinctUntilChanged()
        .flatMapLatest { if (it) host.state else cloud.state }
        .stateIn(scope, SharingStarted.Eagerly, SyncState())

    override suspend fun drainAll(): Boolean = if (isHost()) host.drainAll() else cloud.drainAll()

    override fun nudge() {
        cloud.nudge()
        host.nudge()
    }

    override fun start() {
        cloud.start()
        host.start()
    }
}
