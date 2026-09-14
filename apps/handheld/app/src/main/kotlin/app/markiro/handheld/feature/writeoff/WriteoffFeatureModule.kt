package app.markiro.handheld.feature.writeoff

import app.markiro.handheld.core.network.Strict
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.writeoff.WriteoffMirror
import app.markiro.handheld.core.writeoff.WriteoffSyncEngine
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import kotlinx.serialization.json.Json
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object WriteoffFeatureModule {
    @Provides
    @Singleton
    fun writeoffGateway(
        db: HandheldDatabase,
        meta: MetaStore,
        mirror: WriteoffMirror,
        engine: WriteoffSyncEngine,
        @Strict json: Json,
    ): WriteoffGateway = WriteoffRepository(db, meta, mirror, engine, json)
}
