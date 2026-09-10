package app.markiro.handheld.feature.pairing

import app.markiro.handheld.core.storage.CredentialStore
import app.markiro.handheld.core.storage.DeviceConfigDao
import app.markiro.handheld.core.storage.RosterStore
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent

@Module
@InstallIn(SingletonComponent::class)
object PairingModule {
    @Provides
    fun provisioningStore(roster: RosterStore, credential: CredentialStore, config: DeviceConfigDao): ProvisioningStore =
        RoomProvisioningStore(roster, credential, config)
}
