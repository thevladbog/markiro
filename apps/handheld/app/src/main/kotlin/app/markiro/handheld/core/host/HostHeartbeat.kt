package app.markiro.handheld.core.host

import app.markiro.handheld.core.network.host.HostApi
import app.markiro.handheld.core.storage.DeviceConfigDao
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.storage.RecoveryBlocked

/**
 * One beat of the link with the host, run by the sync loop at its own pace: `GET /v1/hello` through [HostLinkMonitor] (so the screens' state is
 * real), and what a changed `restoreEpoch` asks of this device (spec 6.5 and 8.5, point 5): tell the restored host every SSCC block this device
 * holds (`POST /v1/device/sscc/blocks/known`, done by the monitor through [HostBlockSupplier.registerKnown] and repeated on the next beat if it
 * failed) and forget the registry's mark so the next walk is a full one. Nothing else is re-run: the queue and the reference data stay as they
 * are, and the line is not stopped.
 */
class HostHeartbeat(
    private val db: HandheldDatabase,
    private val monitor: HostLinkMonitor,
    private val api: () -> HostApi,
    private val config: DeviceConfigDao,
    private val blocks: HostBlockSupplier,
    private val meta: MetaStore,
) {
    suspend fun beat() {
        if (config.get()?.backend != "host") return
        try {
            db.recovery.work {
                monitor.heartbeat(api(), config) { blocks.registerKnown() }.onSuccess { observation ->
                    if (observation.restored) meta.remove(MetaStore.BOX_REGISTRY_UNTIL)
                }
            }
        } catch (_: RecoveryBlocked) {
            // The device is being paired again: the next beat finds its owner.
        }
    }
}
