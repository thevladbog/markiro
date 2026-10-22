package app.markiro.handheld.core.host

import app.markiro.handheld.core.backend.HostBackend
import app.markiro.handheld.core.box.SsccPool
import app.markiro.handheld.core.network.RevocationBus
import app.markiro.handheld.core.network.host.AddressFallbackTransport
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
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import java.io.IOException
import javax.inject.Singleton

/**
 * The transport of a paired device: the origin, the pin and the key are read from the recovery owner at every call (the device may have
 * been paired again to another certificate), and the client is rebuilt only when the pin changes. A device that is not paired with a
 * host reaches nothing.
 */
class DeviceHostTransport(
    private val recovery: DeviceRecovery,
    /** The addresses of the pairing payload (`device_config.hostAddresses`), active one first; the port is the owner's. */
    private val addresses: suspend () -> List<String> = { emptyList() },
) : HostTransport {
    private var cached: Pair<String, OkHttpClient>? = null
    private val active = java.util.concurrent.atomic.AtomicReference<String?>(null)

    private fun client(pin: String): OkHttpClient = synchronized(this) {
        cached?.takeIf { it.first == pin }?.second ?: HostHttpClient.pinned(pin, datasetEpoch = recovery::processDatasetEpoch) { key() }.also { cached = pin to it }
    }

    /** Thrown as `IOException` so the transport reports "unreachable", never a crash inside the interceptor chain. */
    private fun key(): String = runCatching { recovery.key(recovery.token()) }.getOrElse { throw IOException("the device key is not available") }

    /**
     * The owner's origin first, then the other addresses of the payload on the owner's port, all through the client pinned to the owner's
     * certificate: an address that answers with another certificate is refused like one that does not answer.
     */
    private suspend fun transport(): HostTransport? {
        val owner = recovery.current().owner ?: return null
        val pin = owner.pinSha256 ?: return null
        val port = owner.serverOrigin.toHttpUrlOrNull()?.port
        val others = if (port == null) emptyList() else addresses().map { "https://$it:$port" }
        val origins = (listOf(owner.serverOrigin) + others).distinct()
        return AddressFallbackTransport(origins, { origin -> OkHttpHostTransport(client(pin), { origin }) }, active)
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
    fun hostApi(recovery: DeviceRecovery, config: DeviceConfigDao): HostApi =
        HostApi(DeviceHostTransport(recovery) { config.get()?.hostAddresses?.split(',')?.map(String::trim)?.filter(String::isNotEmpty).orEmpty() })

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
    fun hostOrgPrint(meta: MetaStore, api: HostApi): HostOrgPrint = HostOrgPrint(api, meta)

    @Provides
    @Singleton
    fun hostBoxRegistry(db: HandheldDatabase, meta: MetaStore, api: HostApi): HostBoxRegistry = HostBoxRegistry(db, meta, api)

    /** What a changed epoch asks is done by [HostHeartbeat] with the observation the monitor returns (the callback cannot suspend). */
    @Provides
    @Singleton
    fun hostLinkMonitor(): HostLinkMonitor = HostLinkMonitor(now = System::currentTimeMillis, onRestore = {})

    @Provides
    @Singleton
    fun shiftParticipationStore(db: HandheldDatabase): ShiftParticipationStore = ShiftParticipationStore(db)

    @Provides
    @Singleton
    fun hostParticipation(db: HandheldDatabase, api: HostApi, revocation: HostRevocation, config: DeviceConfigDao, store: ShiftParticipationStore): HostParticipation =
        HostParticipation(db, { api }, HostCalls(revocation::current) { revocation.reject(it) }, store, config)

    @Provides
    @Singleton
    fun hostHeartbeat(
        db: HandheldDatabase,
        monitor: HostLinkMonitor,
        api: HostApi,
        config: DeviceConfigDao,
        blocks: HostBlockSupplier,
        meta: MetaStore,
        reference: HostReferenceSync,
        participation: HostParticipation,
    ): HostHeartbeat = HostHeartbeat(
        db, monitor, { api }, config, blocks, meta,
        participation = participation::beat, participationStale = participation::markStale,
    ) { reference.refreshDevice() }

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
        orgPrint: HostOrgPrint,
        registry: HostBoxRegistry,
        store: ShiftParticipationStore,
    ): HostBackend = HostBackend({ api }, config, db, supplier, HostCalls(revocation::current) { revocation.reject(it) }, reference, operators, orgPrint, registry, store)

    @Provides
    @Singleton
    fun hostSyncEngine(db: HandheldDatabase, config: DeviceConfigDao, api: HostApi, revocation: HostRevocation, heartbeat: HostHeartbeat): HostSyncEngine =
        HostSyncEngine(db, { api }, HostAckMapper(db), HostCalls(revocation::current) { revocation.reject(it) }, config, beat = heartbeat::beat)

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
