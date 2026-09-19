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
import app.markiro.handheld.core.storage.PalletMembershipRemovalEntity
import app.markiro.handheld.core.storage.PalletPrint
import app.markiro.handheld.core.storage.RemovalStatus
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

    /**
     * The device could not answer at all -- it is not paired, so there is no
     * owner to write a pallet against.
     *
     * Deliberately not [UnknownBox]: «Короб неизвестен. Обновите реестр» sends
     * the operator to refresh a registry that is not the problem, and they
     * would keep scanning a box that can never be accepted on this device.
     */
    data object Unavailable : AttachResult
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
 * An open pallet is a DRAFT: no SSCC, no label, no export. So [remove] takes a
 * box off it whatever the membership's status -- the row goes at once and the
 * server learns through a queued `pallet_membership_removals` record -- and a
 * draft emptied that way is deleted outright rather than closed or marked
 * disassembled (spec 2026-09-18-open-pallet-box-removal §3.2).
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

    /**
     * The checks of spec §3.2, in order; lease → lock → transaction, as
     * `CloseBox` does: `ThatIsAPallet` → `UnknownBox` → a concrete foreign
     * `OnAnotherPallet(sscc)` → `AlreadyOnThisPallet` → `OnAnotherLocalPallet`
     * → the open-but-unresolved `OnAnotherPallet(null)` → `UnknownProduct` →
     * `OtherProduct` → accept.
     *
     * The concrete-SSCC `OnAnotherPallet` check runs before
     * `AlreadyOnThisPallet` on purpose: a non-null `palletSscc` means another
     * device already CLOSED a pallet around this box, which is a real,
     * already-settled conflict that outranks a merely pending/sent membership
     * row we still hold locally on our own open pallet. Once a membership is
     * accepted and the registry refreshes, our own accepted row reads
     * `palletActive = true` with `palletSscc` still null (that pallet is still
     * open), so the null-SSCC form of `OnAnotherPallet` must stay AFTER
     * `AlreadyOnThisPallet`: otherwise every duplicate re-scan of an accepted
     * box would turn into a hard refusal instead of the soft, idempotent one
     * this same pallet already holds it under.
     */
    suspend fun attach(sscc: String, operatorId: String?): AttachResult = db.recovery.exclusive {
        lock.withLock { attachOwned(sscc, operatorId) }
    }

    private suspend fun attachOwned(sscc: String, operatorId: String?): AttachResult {
        val deviceId = deviceId() ?: return AttachResult.Unavailable
        // The registry lists boxes and never pallets, so a pallet label would
        // otherwise read as an unknown box. Extension digit 1 is a pallet SSCC
        // by construction; the lookup catches a pallet this device closed
        // whose label was reprinted under some other numbering.
        if (sscc.firstOrNull() == '1' || db.palletDao().bySscc(sscc) != null) return AttachResult.ThatIsAPallet
        val box = db.boxRegistryDao().bySscc(sscc) ?: return AttachResult.UnknownBox
        val open = db.palletDao().openWarehouse(deviceId)
        // A concrete foreign SSCC means another device already CLOSED a pallet
        // around this box: that is a real, already-settled conflict, and it
        // outranks any membership row we hold locally, including a
        // pending/sent one on our own open pallet. Check it before
        // `AlreadyOnThisPallet` so a closed foreign pallet is never masked by
        // our own soft duplicate short-circuit.
        if (box.palletActive && box.palletSscc != null) return AttachResult.OnAnotherPallet(box.palletSscc)
        // A REJECTED row is not membership: the server refused it, so the
        // operator must be able to resolve the conflict and re-scan the same
        // box onto the same pallet. The stale row is cleared below. This must
        // run before `OnAnotherLocalPallet`/`OnAnotherPallet`: after the server
        // accepts this box's membership and the registry refreshes, the box's
        // own row already reads `palletActive = true` (with `palletSscc` still
        // null while that pallet is open), and a duplicate scan must stay the
        // soft `AlreadyOnThisPallet` rather than read as a conflict with itself.
        val existing = open?.let { pallet -> db.palletMembershipDao().byPallet(pallet.palletId).firstOrNull { it.sscc == sscc } }
        if (existing != null && existing.status != MembershipStatus.REJECTED) return AttachResult.AlreadyOnThisPallet
        if (box.localPalletId != null && box.localPalletId != open?.palletId) return AttachResult.OnAnotherLocalPallet
        // A queued removal is this device's own undo of the claim the registry
        // may still show; the server will clear it in the same batch order. The
        // exemption is for the NULL-SSCC form ONLY: a concrete foreign SSCC is a
        // pallet another device already CLOSED around this box, which our own
        // queued removal says nothing about. (The check at the top of this
        // method already returns for that case; this stays consistent with it so
        // a later reordering cannot turn the exemption into a way past a settled
        // cross-device conflict.)
        if (box.palletActive && (box.palletSscc != null || db.palletMembershipRemovalDao().queuedFor(sscc) == 0)) {
            return AttachResult.OnAnotherPallet(box.palletSscc)
        }
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
     * Takes a box back off the OPEN pallet, whatever its membership status
     * (spec 2026-09-18-open-pallet-box-removal §3.2). A pallet already closed or
     * disassembled is refused: it has a label and this flow cannot correct it.
     * The row is gone at once;
     * the server learns through a queued removal record. A `sent` removal
     * belongs to a pinned batch and is never rewritten, so a later removal of
     * the same box is a NEW row; a `pending` one is reused so a batch never
     * carries the same key twice.
     *
     * Takes [PalletLock] like [attach] and [close]: without it, a `remove`
     * could interleave with a `close` that read `countOnPallet` for the same
     * pallet, closing with a stale count or racing the membership delete.
     */
    suspend fun remove(palletId: String, sscc: String, operatorId: String?): Boolean = db.recovery.exclusive {
        lock.withLock {
            db.recovery.commit {
                // Only a DRAFT is reachable from here. A closed or disassembled
                // pallet has an SSCC, a printed label and possibly an export, so
                // taking a box off it would leave the paper on the stack
                // overstating it with nothing to correct it; that operator's
                // route is the disassemble flow, and the server refuses the same
                // way (`pallet_closed`).
                val open = db.palletDao().get(palletId)
                if (open == null || open.closedAt != null || open.disassembledAt != null) return@commit false
                val row = db.palletMembershipDao().byPallet(palletId).firstOrNull { it.sscc == sscc }
                if (row == null || row.status == MembershipStatus.REJECTED) return@commit false
                db.palletMembershipDao().delete(palletId, sscc)
                db.boxRegistryDao().release(sscc)
                // Optimistic: the server will say exactly this once the removal lands.
                db.boxRegistryDao().clearPallet(sscc)
                val reusable = db.palletMembershipRemovalDao().pendingFor(palletId, sscc)
                if (reusable == null) {
                    db.palletMembershipRemovalDao().insert(
                        PalletMembershipRemovalEntity(
                            palletId = palletId,
                            sscc = sscc,
                            removedAt = Iso.format(clock()),
                            operatorId = operatorId,
                            status = RemovalStatus.PENDING,
                        ),
                    )
                } else {
                    // The key stays unique; only the facts move forward to THIS
                    // removal, which is the one the server will actually apply.
                    db.palletMembershipRemovalDao().refresh(reusable.id, Iso.format(clock()), operatorId)
                }
                if (db.palletMembershipDao().countOnPallet(palletId) == 0) {
                    // An empty draft is nothing: no SSCC, no label, no serial burned.
                    db.palletMembershipDao().deleteForPallet(palletId)
                    db.boxRegistryDao().releaseAll(palletId)
                    db.palletDao().delete(palletId)
                }
                true
            }
        }
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
