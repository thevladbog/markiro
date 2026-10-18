package app.markiro.handheld.core.sync

import kotlinx.coroutines.flow.StateFlow

/**
 * What the consumers of the cloud `SyncEngine` need from it. The cloud engine and `HostSyncEngine` are its two implementations; a
 * device is one or the other for life (`device_config.backend`), and the driver the consumers hold sends each call to the one of its
 * device. A consumer never learns which one it talks to.
 */
interface SyncDriver {
    val state: StateFlow<SyncState>

    /** Sends everything owed now; false on the first failure (the caller retries with backoff). */
    suspend fun drainAll(): Boolean

    /** A recorded scan, a regained network or the heartbeat; cheap and safe from any thread. */
    fun nudge()

    /** Starts the loop of the engine; once. */
    fun start()
}
