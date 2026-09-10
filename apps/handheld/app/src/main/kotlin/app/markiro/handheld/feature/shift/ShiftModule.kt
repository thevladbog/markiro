package app.markiro.handheld.feature.shift

import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.RosterStore
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import kotlinx.serialization.json.Json
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object ShiftModule {
    @Provides
    @Singleton
    fun shiftRepository(api: StationApi, db: HandheldDatabase, roster: RosterStore, json: Json): ShiftRepository =
        ShiftRepository(api, db, roster, json)
}
