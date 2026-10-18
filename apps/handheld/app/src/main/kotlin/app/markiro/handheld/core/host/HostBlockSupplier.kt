package app.markiro.handheld.core.host

import app.markiro.handheld.core.box.SsccPool
import app.markiro.handheld.core.network.BundleSsccDto
import app.markiro.handheld.core.network.host.HostApi
import app.markiro.handheld.core.network.host.HostApiError
import app.markiro.handheld.core.network.host.HostFailure
import app.markiro.handheld.core.network.host.KnownBlock
import app.markiro.handheld.core.pallets.SsccBlockApplier
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
import java.util.UUID

/**
 * The device's SSCC blocks from the host (spec 8.5, point 5): a block is requested when the pool is dry or below half a block; the request id is
 * kept until the block is held, so a lost answer is repeated under the same id and the host gives the same block. A block of the host carries its
 * id, which `box_closed` and `pallet_closed` name.
 */
class HostBlockSupplier(
    private val db: HandheldDatabase,
    private val meta: MetaStore,
    private val api: HostApi,
    private val pool: SsccPool,
    private val blocks: SsccBlockApplier,
    private val requestId: () -> String = { UUID.randomUUID().toString() },
) {
    suspend fun ensure(issuerPrefix: String, extension: Int): Result<Unit> = runCatching {
        val remaining = pool.remaining(issuerPrefix, extension)
        val pending = meta.get(requestKey(extension))
        if (pending == null && remaining >= size(extension) / 2) return@runCatching
        val id = pending ?: requestId().also { meta.put(requestKey(extension), it) }
        val block = api.block(id, issuerPrefix, extension).getOrThrow()
        blocks.apply(BundleSsccDto(block.issuerPrefix, block.extension, block.fromSerial, block.toSerial, null, block.id), emptyList())
        meta.remove(requestKey(extension))
    }

    /** After a restore of the host from a copy it knows no block of ours (`restoreEpoch` changed): tell it every one we hold (`POST /v1/device/sscc/blocks/known`). */
    suspend fun registerKnown(): Result<Unit> = runCatching {
        val held = db.ssccPoolDao().allWithBlockId()
        if (held.isEmpty()) return@runCatching
        val results = api.knownBlocks(held.map { KnownBlock(checkNotNull(it.blockId), it.issuerPrefix, it.extensionDigit, it.fromSerial, it.toSerial) }).getOrThrow()
        // A block the host refuses (an overlap with one it gave to another device) is not hidden: the registration is not done.
        results.firstOrNull { it.outcome == "refused" }?.let { throw HostApiError(HostFailure.Constraint(it.code ?: "block_refused")) }
    }

    private fun requestKey(extension: Int) = "host_block_request:$extension"

    /** A block's size on the host (`site.boxBlockSize` 2000, `palletBlockSize` 200 by default). */
    private fun size(extension: Int): Long = if (extension == 0) 2000L else 200L
}
