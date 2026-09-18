package app.markiro.handheld.core.pallets

import app.markiro.handheld.core.box.ServerRange
import app.markiro.handheld.core.box.SsccPool
import app.markiro.handheld.core.network.BundleSsccDto

/**
 * Seeds the device-wide SSCC pool from a server block. Shared by the shift
 * bundle (box and pallet blocks) and the pallet bootstrap, which hands out the
 * same extension-1 block without a shift.
 */
class SsccBlockApplier(private val pool: SsccPool) {
    /**
     * Revoked blocks are dropped BEFORE the new one is applied. Burning picks
     * the lowest `fromSerial` with room, so a revoked range left in place keeps
     * winning over the replacement an admin just cut, and the reseeded number
     * never reaches a label.
     *
     * The block's OWN `fromSerial` is excluded from that list, belt and braces
     * with the server's matching exclusion. Two blocks can share a `fromSerial`
     * -- a revoked one and the replacement cut after an admin reseeded the
     * counter back to a value already seeded before -- and deleting that row
     * here is unrecoverable: the delete takes the local cursor with it, and
     * `addRange` then rebuilds it from the server's `consumedThroughSerial`,
     * still null while this device's printed labels sit unsent. Burning would
     * hand out serials that are already on physical labels, which no later sync
     * repairs.
     *
     * Scoped to the prefix AND digit the block itself names: `dropRanges` keys
     * on all three, so crossing the streams would let a pallet revocation
     * delete a box range that merely shares a `fromSerial`.
     *
     * Call it outside a shift transaction: the pool is device-wide, not any one
     * shift's, and it holds its own lock.
     */
    suspend fun apply(block: BundleSsccDto?, revokedFrom: List<Long>) {
        if (block == null) return
        pool.dropRanges(
            block.issuerPrefix,
            block.extensionDigit,
            revokedFrom.filter { it != block.fromSerial },
        )
        pool.addRange(
            ServerRange(
                issuerPrefix = block.issuerPrefix,
                extensionDigit = block.extensionDigit,
                fromSerial = block.fromSerial,
                toSerial = block.toSerial,
                consumedThroughSerial = block.consumedThroughSerial,
            ),
        )
    }
}
