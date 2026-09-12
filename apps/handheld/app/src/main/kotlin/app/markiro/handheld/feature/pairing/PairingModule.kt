package app.markiro.handheld.feature.pairing

import app.markiro.handheld.core.storage.DeviceRecovery
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent

@Module
@InstallIn(SingletonComponent::class)
object PairingModule {
    @Provides
    fun provisioningStore(recovery: DeviceRecovery): ProvisioningStore = RoomProvisioningStore(recovery)
}
