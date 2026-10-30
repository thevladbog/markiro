package app.markiro.handheld.feature.disassembly

import app.markiro.handheld.core.host.*
import app.markiro.handheld.core.network.host.*
import app.markiro.handheld.core.pallets.BoxRegistryMirror
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.sync.SyncDriver
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object PackDisassemblyModule {
    @Provides @Singleton
    fun gateway(db:HandheldDatabase,revocation:HostRevocation,mirror:BoxRegistryMirror,sync:SyncDriver):PackDisassemblyGateway = HostPackDisassembly(
        db=db,
        apiFor={ token ->
            // Freeze origin, certificate, credential generation AND dataset epoch for this
            // attempt. A late callback must never send an old intent with a new device key.
            val owner=token.owner
            val epoch=db.recovery.processDatasetEpoch()
            val client=HostHttpClient.pinned(checkNotNull(owner.pinSha256),datasetEpoch={epoch}) { db.recovery.key(token) }
            HostApi(OkHttpHostTransport(client,{owner.serverOrigin}))
        },
        calls=HostCalls(revocation::current) { revocation.reject(it) },
        refresh={mirror.walk();Unit},
        nudge=sync::nudge,
    )
}
