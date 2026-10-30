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
 * failed) and forget the registry's mark so the next walk is a full one. Plan 2b: it also sends owed leaves and refreshes the shared-shift figures, or marks them stale when the host did not answer. Nothing else is re-run: the queue and the reference data stay as they
 * are, and the line is not stopped.
 */
class HostHeartbeat(
    private val db: HandheldDatabase,
    private val monitor: HostLinkMonitor,
    private val api: () -> HostApi,
    private val config: DeviceConfigDao,
    private val blocks: HostBlockSupplier,
    private val meta: MetaStore,
    /** What a beat that reached the host also does for shared shifts: sends the leaves still owed and reads the worked shift's figures (plan 2b). */
    private val participation: suspend () -> Unit = {},
    /** What a beat that did not reach the host does: marks those figures stale. */
    private val participationStale: suspend () -> Unit = {},
    /** What a beat that reached the host also does: reads the device's own record again (its line may have been assigned or changed). */
    private val device: suspend () -> Unit = {},
) {
    suspend fun beat() {
        if (config.get()?.backend != "host") return
        try {
            db.recovery.work {
                monitor.heartbeat(api(), config, beforeRestore = { hello ->
                    if (db.recovery.observeHostDataset(hello.hostId, hello.datasetEpoch)) throw RecoveryBlocked()
                }) { blocks.registerKnown() }.onSuccess { observation ->
                    if (observation.restored) meta.remove(MetaStore.BOX_REGISTRY_UNTIL)
                    meta.put(MetaStore.HOST_PROTOCOL, observation.protocol.toString())
                    // A failure of this read is not the link's: the shift list asks again.
                    runCatching { device() }.onFailure { if (it is kotlinx.coroutines.CancellationException) throw it }
                    runCatching { participation() }.onFailure { if (it is kotlinx.coroutines.CancellationException) throw it }
                }.onFailure {
                    runCatching { participationStale() }.onFailure { e -> if (e is kotlinx.coroutines.CancellationException) throw e }
                }
            }
        } catch (_: RecoveryBlocked) {
            // The device is being paired again: the next beat finds its owner.
        }
    }
}
