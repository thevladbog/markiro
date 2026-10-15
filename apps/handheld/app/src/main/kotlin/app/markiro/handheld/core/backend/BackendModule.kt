package app.markiro.handheld.core.backend

import app.markiro.handheld.core.storage.DeviceConfigDao
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

/** The host's backend until it exists (tasks С4–Д1 replace it): a device paired with a host answers nothing yet. */
object HostBackendHolder {
    val backend: StationBackend = NoBackend
}

@Module
@InstallIn(SingletonComponent::class)
object BackendModule {
    @Provides
    @Singleton
    fun backend(config: DeviceConfigDao, cloud: CloudBackend): StationBackend =
        BackendSelector(config, cloud, HostBackendHolder.backend)
}
