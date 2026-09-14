package app.markiro.handheld.core.writeoff

import app.markiro.handheld.core.network.ServerUrlProvider
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.network.Strict
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
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object WriteoffModule {
    @Provides
    @Singleton
    fun writeoffMirror(api: StationApi, db: HandheldDatabase, meta: MetaStore): WriteoffMirror =
        WriteoffMirror(api, db, meta)

    /** The authenticated client already adds the key, the capabilities, revocation and reachability handling. */
    @Provides
    @Singleton
    fun writeoffSyncEngine(
        db: HandheldDatabase,
        meta: MetaStore,
        client: okhttp3.Call.Factory,
        serverUrl: ServerUrlProvider,
        @Strict json: Json,
    ): WriteoffSyncEngine = WriteoffSyncEngine(
        db, meta, SyncTransport(client) { serverUrl.current() }, json, CoroutineScope(SupervisorJob() + Dispatchers.IO),
    )
}
