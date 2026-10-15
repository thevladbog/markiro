package app.markiro.handheld.core.backend

import app.markiro.handheld.core.storage.DeviceConfigDao
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object BackendModule {
    @Provides
    @Singleton
    fun backend(config: DeviceConfigDao, cloud: CloudBackend, host: HostBackend): StationBackend =
        BackendSelector(config, cloud, host)
}
