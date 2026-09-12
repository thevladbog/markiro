package app.markiro.handheld.core.sync

import android.content.Context
import app.markiro.handheld.core.inventory.InventorySyncEngine
import app.markiro.handheld.core.network.ServerUrlProvider
import app.markiro.handheld.core.network.Strict
import app.markiro.handheld.core.storage.DeviceConfigDao
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object SyncModule {
    /** The authenticated client already adds the key, the capabilities, revocation and reachability handling. */
    @Provides
    @Singleton
    fun syncEngine(
        db: HandheldDatabase,
        meta: MetaStore,
        config: DeviceConfigDao,
        client: okhttp3.Call.Factory,
        serverUrl: ServerUrlProvider,
        @Strict json: Json,
    ): SyncEngine = SyncEngine(
        db = db,
        meta = meta,
        config = config,
        transport = SyncTransport(client) { serverUrl.current() },
        json = json,
        scope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
    )

    @Provides
    @Singleton
    fun connectivityNudger(@ApplicationContext context: Context, engine: SyncEngine, inventory: InventorySyncEngine): ConnectivityNudger =
        ConnectivityNudger(context) {
            engine.nudge()
            inventory.nudge()
        }
}
