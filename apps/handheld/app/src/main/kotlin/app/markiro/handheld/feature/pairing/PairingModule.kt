package app.markiro.handheld.feature.pairing

import app.markiro.handheld.core.network.host.HostPairingGateway
import app.markiro.handheld.core.network.host.RealHostPairingGateway
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

    @Provides
    fun hostProvisioningStore(recovery: DeviceRecovery): HostProvisioningStore = RoomHostProvisioningStore(recovery)

    @Provides
    fun hostPairingGateway(): HostPairingGateway = RealHostPairingGateway()

    /** A placeholder until task С5 provides the real first read of the host's feed: pairing succeeds with nothing to wait for. */
    @Provides
    fun hostBootstrap(): HostBootstrap = HostBootstrap { Result.success(Unit) }
}
