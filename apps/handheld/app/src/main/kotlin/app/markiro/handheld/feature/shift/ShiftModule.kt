package app.markiro.handheld.feature.shift

import app.markiro.handheld.core.box.SsccPool
import app.markiro.handheld.core.backend.StationBackend
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.feature.work.ApiTeamRefresher
import app.markiro.handheld.feature.work.TeamRefresher
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
    fun shiftRepository(backend: StationBackend, db: HandheldDatabase, json: Json, pool: SsccPool): ShiftRepository =
        ShiftRepository(backend, db, json, pool)

    @Provides
    fun teamRefresher(api: StationApi): TeamRefresher = ApiTeamRefresher(api)

    @Provides
    fun shiftCloser(db: HandheldDatabase, participation: app.markiro.handheld.core.host.HostParticipation): ShiftCloser =
        ShiftCloser(db, refresh = participation::refresh)
}
