package app.markiro.handheld.core.host

import app.markiro.handheld.core.backend.HostBackend
import app.markiro.handheld.core.box.SsccPool
import app.markiro.handheld.core.network.RevocationBus
import app.markiro.handheld.core.network.host.HostApi
import app.markiro.handheld.core.network.host.HostHttpClient
import app.markiro.handheld.core.network.host.HostResult
import app.markiro.handheld.core.network.host.HostTransport
import app.markiro.handheld.core.network.host.OkHttpHostTransport
import app.markiro.handheld.core.network.host.TransportFailure
import app.markiro.handheld.core.pallets.SsccBlockApplier
import app.markiro.handheld.core.storage.DeviceConfigDao
import app.markiro.handheld.core.storage.DeviceRecovery
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.storage.OperatorDao
import app.markiro.handheld.core.sync.SyncDriver
import app.markiro.handheld.core.sync.SyncEngine
import app.markiro.handheld.feature.pairing.HostBootstrap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import okhttp3.OkHttpClient
import java.io.IOException
import javax.inject.Singleton

/**
 * The transport of a paired device: the origin, the pin and the key are read from the recovery owner at every call (the device may have
 * been paired again to another certificate), and the client is rebuilt only when the pin changes. A device that is not paired with a
 * host reaches nothing.
 */
class DeviceHostTransport(private val recovery: DeviceRecovery) : HostTransport {
    private var cached: Pair<String, OkHttpClient>? = null

    private fun client(pin: String): OkHttpClient = synchronized(this) {
        cached?.takeIf { it.first == pin }?.second ?: HostHttpClient.pinned(pin) { key() }.also { cached = pin to it }
    }

    /** Thrown as `IOException` so the transport reports "unreachable", never a crash inside the interceptor chain. */
    private fun key(): String = runCatching { recovery.key(recovery.token()) }.getOrElse { throw IOException("the device key is not available") }

    private fun transport(): HostTransport? {
        val owner = recovery.current().owner ?: return null
        val pin = owner.pinSha256 ?: return null
        return OkHttpHostTransport(client(pin), { recovery.current().owner?.serverOrigin ?: owner.serverOrigin })
    }

    override suspend fun get(path: String): HostResult = transport()?.get(path) ?: HostResult.Failed(TransportFailure.UNREACHABLE)

    override suspend fun post(path: String, body: String): HostResult =
        transport()?.post(path, body) ?: HostResult.Failed(TransportFailure.UNREACHABLE)
}

@Module
@InstallIn(SingletonComponent::class)
object HostModule {
    @Provides
    @Singleton
    fun hostApi(recovery: DeviceRecovery): HostApi = HostApi(DeviceHostTransport(recovery))

    @Provides
    @Singleton
    fun hostReferenceSync(db: HandheldDatabase, config: DeviceConfigDao, meta: MetaStore, api: HostApi): HostReferenceSync =
        HostReferenceSync(db, config, meta, api)

    @Provides
    @Singleton
    fun hostBlockSupplier(db: HandheldDatabase, meta: MetaStore, api: HostApi, pool: SsccPool, blocks: SsccBlockApplier): HostBlockSupplier =
        HostBlockSupplier(db, meta, api, pool, blocks)

    @Provides
    @Singleton
    fun hostLinkMonitor(): HostLinkMonitor = HostLinkMonitor(now = System::currentTimeMillis, onRestore = {})

    @Provides
    @Singleton
    fun hostRevocation(recovery: DeviceRecovery, bus: RevocationBus): HostRevocation = HostRevocation(recovery, bus)

    @Provides
    @Singleton
    fun hostBackend(
        api: HostApi,
        config: DeviceConfigDao,
        db: HandheldDatabase,
        supplier: HostBlockSupplier,
        revocation: HostRevocation,
        reference: HostReferenceSync,
        operators: OperatorDao,
    ): HostBackend = HostBackend({ api }, config, db, supplier, HostCalls { revocation.reject() }, reference, operators)

    @Provides
    @Singleton
    fun hostSyncEngine(db: HandheldDatabase, config: DeviceConfigDao, api: HostApi, revocation: HostRevocation): HostSyncEngine =
        HostSyncEngine(db, { api }, HostAckMapper(db), HostCalls { revocation.reject() }, config)

    /** What the consumers of the sync engine hold: the cloud's engine or the host's, by the backend of this device at each call. */
    @Provides
    @Singleton
    fun syncDriver(config: DeviceConfigDao, cloud: SyncEngine, host: HostSyncEngine): SyncDriver =
        BackendSyncDriver(config, cloud, host, CoroutineScope(SupervisorJob() + Dispatchers.IO))

    @Provides
    fun hostBootstrap(
        db: HandheldDatabase,
        config: DeviceConfigDao,
        meta: MetaStore,
        api: HostApi,
        reference: HostReferenceSync,
        blocks: HostBlockSupplier,
    ): HostBootstrap = HostBootstrapImpl(db, config, meta, api, reference, blocks)
}
