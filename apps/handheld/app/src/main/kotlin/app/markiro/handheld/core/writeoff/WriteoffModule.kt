package app.markiro.handheld.core.writeoff

import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object WriteoffModule {
    @Provides
    @Singleton
    fun writeoffMirror(api: StationApi, db: HandheldDatabase, meta: MetaStore): WriteoffMirror =
        WriteoffMirror(api, db, meta)
}
