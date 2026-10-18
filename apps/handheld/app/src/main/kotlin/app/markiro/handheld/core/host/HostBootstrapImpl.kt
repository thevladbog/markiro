package app.markiro.handheld.core.host

import app.markiro.handheld.core.network.host.HostApi
import app.markiro.handheld.core.storage.DeviceConfigDao
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.box.SsccPool
import app.markiro.handheld.feature.pairing.HostBootstrap

/**
 * The first read of the host after a claim (spec 8.3, point 4): the feed, the organization's SSCC prefix, the device's line, and a block of
 * box SSCC. A failure of any step is a failure of the whole: pairing is not done before the device can work offline.
 */
class HostBootstrapImpl(
    private val db: HandheldDatabase,
    private val config: DeviceConfigDao,
    private val meta: MetaStore,
    private val api: HostApi,
    private val reference: HostReferenceSync,
    private val blocks: HostBlockSupplier,
) : HostBootstrap {
    override suspend fun initialSync(): Result<Unit> = runCatching {
        val hello = api.hello().getOrThrow()
        if (db.recovery.observeHostDataset(hello.hostId, hello.datasetEpoch)) throw app.markiro.handheld.core.storage.RecoveryBlocked()
        reference.sync().getOrThrow()
        val org = api.orgPrint().getOrThrow()
        meta.put(MetaStore.PALLET_BOOTSTRAP_ISSUER_PREFIX, org.issuerPrefix)
        val device = api.device().getOrThrow()
        db.recovery.commit { config.get()?.let { config.upsert(it.copy(lineId = device.lineId)) } }
        reference.refreshLineName()
        blocks.ensure(org.issuerPrefix, SsccPool.BOX_EXTENSION_DIGIT).getOrThrow()
    }
}
