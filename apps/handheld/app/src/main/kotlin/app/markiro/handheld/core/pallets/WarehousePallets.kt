package app.markiro.handheld.core.pallets

import app.markiro.handheld.core.box.ClosePallet
import app.markiro.handheld.core.box.ClosePalletResult
import app.markiro.handheld.core.box.PalletLock
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MembershipStatus
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.storage.PalletEntity
import app.markiro.handheld.core.storage.PalletKind
import app.markiro.handheld.core.storage.PalletMembershipEntity
import app.markiro.handheld.core.storage.PalletPrint
import app.markiro.handheld.core.util.Iso
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import java.util.UUID

/** What a scan onto the device's open warehouse pallet did, or why it did nothing (spec §3.2). */
sealed interface AttachResult {
    data class Attached(
        val pallet: PalletEntity,
        val boxCount: Int,
        val capacity: Int?,
        val atCapacity: Boolean,
    ) : AttachResult

    /** The same box scanned twice. Soft and idempotent: nothing changed, nothing is wrong. */
    data object AlreadyOnThisPallet : AttachResult

    /** The registry says another pallet holds it. Raw 18 digits, or null while that pallet is open. */
    data class OnAnotherPallet(val palletSscc: String?) : AttachResult

    /** Claimed by another pallet THIS device built, before any registry refresh could say so. */
    data object OnAnotherLocalPallet : AttachResult

    /** A warehouse pallet carries one product; [productName] is the scanned box's. */
    data class OtherProduct(val productName: String) : AttachResult

    data object UnknownBox : AttachResult

    /** The box is known but its product is not in the bootstrap mirror yet. */
    data object UnknownProduct : AttachResult

    data object ThatIsAPallet : AttachResult
}

/**
 * The device's own warehouse pallet: open on the first accepted scan, filled by
 * scanning closed boxes, closed by the operator or by reaching capacity.
 *
 * Unlike a production pallet, this one belongs to the DEVICE rather than to a
 * shift -- there need not be a shift at all -- and its member boxes were closed
 * elsewhere, so it holds no local `boxes` rows. Membership lives in
 * `pallet_memberships`, which is also the sync channel's queue.
 *
 * Every entry point takes the recovery lease FIRST, then [PalletLock], and only
 * then opens a transaction. That is the same order `CloseBox` and `ClosePallet`
 * take them in, and it is what keeps the automatic close-at-capacity and the
 * operator's own «Закрыть» out of an ABBA deadlock. See `PalletLock`.
 */
class WarehousePallets(
    private val db: HandheldDatabase,
    private val lock: PalletLock,
    private val closer: ClosePallet,
    private val meta: MetaStore,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    suspend fun deviceId(): String? = db.deviceConfigDao().get()?.deviceId

    @OptIn(ExperimentalCoroutinesApi::class)
    fun observeOpen(): Flow<PalletEntity?> = db.deviceConfigDao().observe().flatMapLatest { config ->
        config?.deviceId?.let { db.palletDao().observeOpenWarehouse(it) } ?: flowOf(null)
    }

    suspend fun capacity(pallet: PalletEntity): Int? =
        pallet.productId?.let { db.palletProductDao().byId(it)?.palletBoxCapacity }

    /** The six checks of spec §3.2, in order; lease → lock → transaction, as `CloseBox` does. */
    suspend fun attach(sscc: String, operatorId: String?): AttachResult = db.recovery.exclusive {
        lock.withLock { attachOwned(sscc, operatorId) }
    }

    private suspend fun attachOwned(sscc: String, operatorId: String?): AttachResult {
        val deviceId = deviceId() ?: return AttachResult.UnknownBox
        // The registry lists boxes and never pallets, so a pallet label would
        // otherwise read as an unknown box. Extension digit 1 is a pallet SSCC
        // by construction; the lookup catches a pallet this device closed
        // whose label was reprinted under some other numbering.
        if (sscc.firstOrNull() == '1' || db.palletDao().bySscc(sscc) != null) return AttachResult.ThatIsAPallet
        val box = db.boxRegistryDao().bySscc(sscc) ?: return AttachResult.UnknownBox
        val open = db.palletDao().openWarehouse(deviceId)
        if (box.localPalletId != null && box.localPalletId != open?.palletId) return AttachResult.OnAnotherLocalPallet
        if (box.palletActive) return AttachResult.OnAnotherPallet(box.palletSscc)
        // A REJECTED row is not membership: the server refused it, so the
        // operator must be able to resolve the conflict and re-scan the same
        // box onto the same pallet. The stale row is cleared below.
        val existing = open?.let { pallet -> db.palletMembershipDao().byPallet(pallet.palletId).firstOrNull { it.sscc == sscc } }
        if (existing != null && existing.status != MembershipStatus.REJECTED) return AttachResult.AlreadyOnThisPallet
        val product = db.palletProductDao().byId(box.productId) ?: return AttachResult.UnknownProduct
        if (open != null && open.productId != box.productId) return AttachResult.OtherProduct(product.name)

        return db.recovery.commit {
            val pallet = open ?: PalletEntity(
                palletId = UUID.randomUUID().toString(),
                shiftId = null,
                // The device IS the terminal for warehouse work: the server keys
                // the closure on `(terminalId, devicePalletId)` exactly as it
                // does for a production pallet.
                terminalId = deviceId,
                sscc = null,
                openedAt = Iso.format(clock()),
                closedAt = null,
                operatorId = operatorId,
                printState = PalletPrint.PENDING,
                printReason = null,
                ackedAt = null,
                kind = PalletKind.WAREHOUSE,
                productId = box.productId,
                deviceId = deviceId,
            ).also { db.palletDao().insert(it) }
            if (existing != null) db.palletMembershipDao().deleteRejected(pallet.palletId, sscc)
            db.palletMembershipDao().insert(
                PalletMembershipEntity(
                    palletId = pallet.palletId,
                    sscc = sscc,
                    addedAt = Iso.format(clock()),
                    operatorId = operatorId,
                    status = MembershipStatus.PENDING,
                    reason = null,
                    winningPalletSscc = null,
                    ackedAt = null,
                    acknowledgedAt = null,
                    // Snapshot, not a join: the registry is a server mirror and
                    // a delta or a full re-walk can drop the row of a box that
                    // is physically still on this pallet.
                    bottleCount = box.bottleCount,
                    productionDate = box.productionDate,
                ),
            )
            db.boxRegistryDao().claim(sscc, pallet.palletId)
            val count = db.palletMembershipDao().countOnPallet(pallet.palletId)
            val capacity = product.palletBoxCapacity
            AttachResult.Attached(pallet, count, capacity, capacity != null && count >= capacity)
        }
    }

    /**
     * Takes a box back off the pallet. False when the row is no longer pending:
     * a `sent` row may already be on the server, and only the server can take
     * that one back.
     */
    suspend fun remove(palletId: String, sscc: String): Boolean = db.recovery.commit {
        val removed = db.palletMembershipDao().deletePending(palletId, sscc) > 0
        if (removed) db.boxRegistryDao().release(sscc)
        removed
    }

    /** Early or at capacity; both are the same closure, and both leave the pallet open on refusal. */
    suspend fun close(operatorId: String?): ClosePalletResult = db.recovery.exclusive {
        lock.withLock { held ->
            val deviceId = deviceId() ?: return@withLock ClosePalletResult.Empty
            val open = db.palletDao().openWarehouse(deviceId) ?: return@withLock ClosePalletResult.Empty
            closer.closeWarehouse(held, open, meta.get(MetaStore.PALLET_BOOTSTRAP_ISSUER_PREFIX), operatorId)
        }
    }

    suspend fun acknowledgeRejections(palletId: String) =
        db.recovery.commit { db.palletMembershipDao().acknowledge(palletId, Iso.format(clock())) }
}
