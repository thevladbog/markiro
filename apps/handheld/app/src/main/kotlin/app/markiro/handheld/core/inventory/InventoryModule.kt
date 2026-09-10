package app.markiro.handheld.core.inventory

import app.markiro.handheld.core.network.ServerUrlProvider
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.network.Strict
import app.markiro.handheld.core.storage.DeviceConfigDao
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.sync.SyncTransport
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object InventoryModule {
    @Provides
    @Singleton
    fun inventoryRecorder(db: HandheldDatabase): InventoryRecorder = InventoryRecorder(db)

    @Provides
    @Singleton
    fun inventoryBundleMirror(db: HandheldDatabase, api: StationApi): InventoryBundleMirror = InventoryBundleMirror(db, api)

    /** The authenticated client already adds the key, the capabilities, revocation and reachability handling. */
    @Provides
    @Singleton
    fun inventorySyncEngine(
        db: HandheldDatabase,
        meta: MetaStore,
        config: DeviceConfigDao,
        client: OkHttpClient,
        serverUrl: ServerUrlProvider,
        @Strict json: Json,
    ): InventorySyncEngine = InventorySyncEngine(
        db, meta, config, SyncTransport(client) { serverUrl.current() }, json, CoroutineScope(SupervisorJob() + Dispatchers.IO),
    )
}
