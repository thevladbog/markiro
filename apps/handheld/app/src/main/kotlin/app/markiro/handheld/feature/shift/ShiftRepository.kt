package app.markiro.handheld.feature.shift

import app.markiro.handheld.core.backend.CloudBackend
import app.markiro.handheld.core.backend.StationBackend
import app.markiro.handheld.core.grants.*
import app.markiro.handheld.core.box.SsccPool
import app.markiro.handheld.core.network.ErrorBody
import app.markiro.handheld.core.network.LineDto
import app.markiro.handheld.core.network.ShiftBundleDto
import app.markiro.handheld.core.network.ShiftDto
import app.markiro.handheld.core.network.ShiftEntryRequest
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.network.UPDATE_REQUIRED_CODE
import app.markiro.handheld.core.network.ValidationPrintDto
import app.markiro.handheld.core.pallets.SsccBlockApplier
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.ShiftEntity
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.json.Json
import retrofit2.HttpException
import java.io.IOException

private const val LINE_FULL_CODE = "shift_line_full"
private const val BUSY_CODE = "shift_busy"

/** Which call the server refused: entering the shift, or downloading its bundle. */
enum class EnterStep { ENTER, BUNDLE }

sealed interface EnterResult {
    data object Ok : EnterResult
    data object UpdateRequired : EnterResult
    data object Closed : EnterResult
    data object Unavailable : EnterResult

    /** Every slot of the line is held by another device (`409 shift_line_full`): the two numbers are the host's. */
    data class LineFull(val active: Int, val maxStations: Int) : EnterResult

    /** An older host (before several devices in one shift) says another device works this shift (`409 shift_busy`). */
    data object Busy : EnterResult

    /** This device closed its part of the shift: the host reads it back, nothing is entered and no bundle is fetched. */
    data object PartClosed : EnterResult

    /**
     * The server refused for a reason this build cannot name. It carries the
     * status and the server's own code so the screen can show them: every such
     * refusal used to be reported as «смена уже закрыта», which sends a line to
     * look at a shift that is wide open and hides the real reason -- an expired
     * subscription, a disabled feature, a revoked device.
     */
    data class Refused(val step: EnterStep, val status: Int, val code: String?) : EnterResult
}

fun ShiftDto.toEntity(existing: ShiftEntity?, now: Long) = ShiftEntity(
    id = id,
    number = number,
    // A shift closed on this device stays closed even while the close is still queued and the server lists it as active.
    status = if (existing?.status == "closed") "closed" else status,
    mode = mode,
    productId = productId,
    // The bundle resolves these from the product; the list carries the shift's own
    // snapshot, which can be older and never has a print name. Once a bundle has
    // been fetched its values win, or a list refresh silently changes what prints.
    productName = if (existing?.bundleFetchedAt != null) existing.productName else productName,
    productPrintName = if (existing?.bundleFetchedAt != null) existing.productPrintName else productPrintName,
    productGtin14 = existing?.productGtin14,
    lineId = lineId,
    lineName = lineName,
    counterpartyName = counterpartyName,
    plannedQty = plannedQty,
    plannedDate = plannedDate,
    productionDate = productionDate,
    boxCapacity = boxCapacity,
    // The station and the handheld both read this same Room column as the
    // pallets-ON signal (CloseBox.kt, WorkViewModel.kt) because the server's
    // own signal, `palletsEnabled`, is a separate field they would otherwise
    // have to thread through every read site. `GET /shifts` returns
    // `palletBoxCapacity` UNGATED -- the cabinet needs the raw column -- so
    // storing it verbatim here would let a plain list refresh turn the local
    // signal on for a shift whose pallets are off, and the device would show
    // the full-screen pallet refusal overlay for a shift that never asked for one.
    palletBoxCapacity = if (palletsEnabled) palletBoxCapacity else null,
    palletsEnabled = palletsEnabled,
    validationPrintMode = validationPrint.mode,
    closePolicyKind = stationCloseAccess?.kind,
    closeOwnerDeviceId = stationCloseAccess?.ownerDeviceId,
    openedAt = openedAt,
    listFetchedAt = now,
    bundleFetchedAt = existing?.bundleFetchedAt,
    enteredAt = existing?.enteredAt,
    leftAt = existing?.leftAt,
    // Everything below comes from the BUNDLE, which the shift list does not carry.
    // Rebuilding the row from a list refresh without them silently strips the SSCC
    // issuer and the box template off a shift already entered, and boxes stop
    // closing for a reason nothing on the screen connects to a list refresh.
    boxLabelTemplate = existing?.boxLabelTemplate,
    // 06d: the pallet template is bundle-only for exactly the same reason, and
    // losing it is the same failure one level up -- every pallet label refuses
    // with `template_missing` and the queue fills with labels nothing can print.
    palletLabelTemplateSpec = existing?.palletLabelTemplateSpec,
    shelfLifeDays = existing?.shelfLifeDays,
    egaisCode = existing?.egaisCode,
    ssccIssuerPrefix = existing?.ssccIssuerPrefix,
    ssccIssuerProblem = existing?.ssccIssuerProblem,
    duplicateVerification = existing?.duplicateVerification,
    duplicateTemplate = existing?.duplicateTemplate,
    duplicateTemplateDigest = existing?.duplicateTemplateDigest,
    duplicatePolicyRevision = existing?.duplicatePolicyRevision,
    allowPreviouslyAcceptedCodes = existing?.takeIf { it.bundleFetchedAt != null }?.allowPreviouslyAcceptedCodes
        ?: validationPrint.allowPreviouslyAcceptedCodes,
)

/**
 * Just enough of the cached row for the other-line confirmation card; `enter`
 * re-fetches the full shift and its bundle from the server regardless of
 * whether the operator got here by scanning a form or picking from the list.
 */
fun ShiftEntity.toDto() = ShiftDto(
    id = id,
    number = number,
    status = status,
    mode = mode,
    validationPrint = ValidationPrintDto(validationPrintMode),
    productId = productId,
    productName = productName,
    productPrintName = productPrintName,
    lineId = lineId,
    lineName = lineName,
    counterpartyName = counterpartyName,
    plannedQty = plannedQty,
    plannedDate = plannedDate,
    productionDate = productionDate,
    boxCapacity = boxCapacity,
    palletBoxCapacity = palletBoxCapacity,
    palletsEnabled = palletsEnabled,
    openedAt = openedAt,
)

/** Shift list cache, entry (server participation + bundle) and the local leave mark. */
class ShiftRepository(
    private val backend: StationBackend,
    private val db: HandheldDatabase,
    private val json: Json,
    private val pool: SsccPool,
    private val blocks: SsccBlockApplier = SsccBlockApplier(pool),
    /** The leaves still owed to a host live here (plan 2b); a cloud device never writes one. */
    private val participation: app.markiro.handheld.core.host.ShiftParticipationStore = app.markiro.handheld.core.host.ShiftParticipationStore(db),
    private val clock: () -> Long = System::currentTimeMillis,
) {
    constructor(
        api: StationApi,
        db: HandheldDatabase,
        json: Json,
        pool: SsccPool,
        blocks: SsccBlockApplier = SsccBlockApplier(pool),
        clock: () -> Long = System::currentTimeMillis,
    ) : this(CloudBackend(api), db, json, pool, blocks, app.markiro.handheld.core.host.ShiftParticipationStore(db), clock)

    fun boxSerialTopUp(
        shiftId: String,
        issuerPrefix: String,
        generation: app.markiro.handheld.core.storage.GenerationToken,
        scope: kotlinx.coroutines.CoroutineScope,
    ) = BoxSerialTopUp(db, pool, shiftId, issuerPrefix, generation, scope, backend::topUpBoxSscc)

    fun observeShifts(): Flow<List<ShiftEntity>> = db.shiftDao().observeAll()

    /**
     * A shift already mirrored on this device, by id -- the same table the
     * list and `enter` itself read. The task-barcode scan checks this only as
     * a fallback, after the shift lists already visible on screen (own line,
     * plus any other-line groups already expanded): an other-line shift lives
     * only in that in-memory state, since a line-less refresh never mirrors it
     * here, while this table still covers a shift cached from a previous
     * entry but no longer listed -- a closed shift, for instance. No
     * barcode-lookup endpoint exists for a shift, and none should be added for
     * what a scan merely shortcuts to the card for.
     */
    suspend fun listed(shiftId: String): ShiftEntity? = db.shiftDao().get(shiftId)

    /** Own line plus unassigned shifts; rows without a bundle that vanished from the list are dropped. */
    suspend fun refreshList(): Boolean = db.recovery.work { refreshListOwned() }

    private suspend fun refreshListOwned(): Boolean = try {
        val items = backend.shifts().items
        val now = clock()
        db.recovery.commit {
            val existing = db.shiftDao().all().associateBy { it.id }
            db.shiftDao().upsertAll(items.map { it.toEntity(existing[it.id], now) })
            db.shiftDao().dropListedExcept(items.map { it.id })
        }
        true
    } catch (_: IOException) {
        false
    } catch (_: HttpException) {
        false
    }

    suspend fun otherLines(ownLineId: String?): List<LineDto> {
        // A host device sees its own line only (the shifts of other lines are not shown there).
        val cloud = backend.cloudApi() ?: return emptyList()
        return cloud.lines().items.filter { it.id != ownLineId }
    }

    suspend fun shiftsOfLine(lineId: String): List<ShiftDto> {
        val cloud = backend.cloudApi() ?: return emptyList()
        return cloud.shifts(lineId = lineId).items.filter { it.status != "closed" }
    }

    /**
     * The two calls are caught separately on purpose. They fail for unrelated
     * reasons -- the first decides whether this device may join at all, the
     * second whether there is anything to work with offline -- and folding them
     * together made a missing product or label template look like a closed
     * shift.
     */
    suspend fun enter(shiftId: String, entryMethod: String = "list"): EnterResult = db.recovery.work { enterOwned(shiftId, entryMethod) }

    private suspend fun enterOwned(shiftId: String, entryMethod: String): EnterResult {
        db.recovery.commit { app.markiro.handheld.core.replacement.ReplacementReadiness(db).requireAdmission("shift", shiftId) }
        val cloud = backend.cloudApi()
        if (cloud != null) GrantTransport(db, cloud).refreshConfiguredDevice()
        val cached = db.shiftDao().get(shiftId)
        val entered = try {
            backend.enter(shiftId, ShiftEntryRequest(entryMethod))
        } catch (e: HttpException) {
            return refusal(EnterStep.ENTER, e)
        } catch (_: IOException) {
            return offline(cached)
        }
        // A host that read a closed part back answers the shift as closed for this device: working it again would only make late facts,
        // and asking for the bundle would enter it a second time. Nothing that starts work is written.
        if (entered.status == "closed") {
            db.recovery.commit {
                db.shiftDao().setStatus(shiftId, "closed")
                db.deviceConfigDao().get()?.let { if (it.activeShiftId == shiftId) db.deviceConfigDao().upsert(it.copy(activeShiftId = null)) }
            }
            return EnterResult.PartClosed
        }
        val bundle = try {
            backend.bundle(shiftId)
        } catch (e: HttpException) {
            return refusal(EnterStep.BUNDLE, e)
        } catch (_: IOException) {
            return offline(cached)
        }
        val now = clock()
        applySsccBlock(bundle)
        db.recovery.commit {
            app.markiro.handheld.core.replacement.ReplacementReadiness(db).requireAdmission("shift", shiftId)
            if(cached?.enteredAt == null) db.grants.start(TaskKind.SHIFT,shiftId,"shift.enter:$shiftId")
            db.shiftDao().upsert(
                bundle.shift.toEntity(cached, now).copy(
                    status = entered.status,
                    productGtin14 = bundle.product.gtin14,
                    productName = bundle.product.name,
                    productPrintName = bundle.product.printName ?: bundle.shift.productPrintName,
                    boxLabelTemplate = bundle.boxLabelTemplate?.spec?.toString(),
                    palletLabelTemplateSpec = bundle.palletLabelTemplate?.spec?.toString(),
                    shelfLifeDays = bundle.product.shelfLifeDays,
                    egaisCode = bundle.product.egaisCode,
                    ssccIssuerPrefix = bundle.sscc?.issuerPrefix,
                    ssccIssuerProblem = bundle.ssccIssuerProblem,
                    duplicateVerification = bundle.shift.validationPrint.verification,
                    duplicateTemplate = bundle.shift.validationPrint.snapshot?.spec?.toString(),
                    duplicateTemplateDigest = bundle.shift.validationPrint.snapshot?.digest,
                    duplicatePolicyRevision = bundle.shift.validationPrint.policyRevision,
                    allowPreviouslyAcceptedCodes = bundle.shift.validationPrint.allowPreviouslyAcceptedCodes,
                    bundleFetchedAt = now,
                    enteredAt = now,
                    leftAt = null,
                ),
            )
            if (cloud != null) db.grants.saveProvenance(TaskKind.SHIFT,shiftId,Json { encodeDefaults=true; explicitNulls=true }.encodeToString(ShiftBundleDto.serializer(),bundle))
            // As on the station, `bundle.operators` is ignored: pairing and the roster refresh are the authoritative sources.
            db.deviceConfigDao().get()?.let { db.deviceConfigDao().upsert(it.copy(activeShiftId = shiftId)) }
        }
        if (cloud != null) GrantTransport(db, cloud).refreshConfiguredTask(TaskKind.SHIFT,shiftId)
        if (cloud != null && bundle.shift.validationPrint.mode == "duplicate_dm") ValidationHistoryMirror(db, cloud, json).refresh(shiftId, bundle.product.id)
        return EnterResult.Ok
    }

    /**
     * Nest serializes a string-payload exception without a `code`, and on these
     * two routes the only codeless conflict is the closed shift itself. A
     * conflict that DOES carry a code is something else entirely -- an
     * unmanaged or expired subscription, a disabled feature -- and naming it is
     * the difference between an operator who can call the office and one who
     * stands in front of a shift the screen insists is closed.
     */
    private fun refusal(step: EnterStep, e: HttpException): EnterResult {
        val body = errorBody(e)
        val code = body?.code
        return when {
            e.code() == 409 && code == UPDATE_REQUIRED_CODE -> EnterResult.UpdateRequired
            e.code() == 409 && code == LINE_FULL_CODE -> {
                val active = body?.active
                val max = body?.maxStations
                // A host that names the refusal but not its numbers still says the shift cannot be joined now.
                if (active != null && max != null) EnterResult.LineFull(active, max) else EnterResult.Busy
            }
            e.code() == 409 && code == BUSY_CODE -> EnterResult.Busy
            e.code() == 409 && code == null -> EnterResult.Closed
            e.code() in 400..499 -> EnterResult.Refused(step, e.code(), code)
            else -> EnterResult.Unavailable
        }
    }

    /** No route to the server: a shift whose bundle is already on the device can still be worked. */
    private suspend fun offline(cached: ShiftEntity?): EnterResult =
        if (cached?.bundleFetchedAt != null) {
            enterOffline(cached)
            EnterResult.Ok
        } else {
            EnterResult.Unavailable
        }

    /**
     * Both serial streams the bundle carries: boxes (extension digit 0) and,
     * since 06d, pallets (digit 1).
     *
     * The pallet block is fully independent of the box one and goes through the
     * identical revoke-then-add path, as `apps/station/src/lib/shift-bundle.ts`
     * does. A device that applies only the box block still joins boxes to a
     * local pallet and still reaches capacity -- and then refuses every close
     * from the capacity-th box onward with `NoSerials`, for the rest of the shift.
     *
     * Outside the shift transaction on purpose: the pool is device-wide, not
     * this shift's, and it holds its own lock.
     */
    private suspend fun applySsccBlock(bundle: ShiftBundleDto) {
        blocks.apply(bundle.sscc, bundle.ssccRevokedFrom)
        blocks.apply(bundle.palletSscc, bundle.palletSsccRevokedFrom)
    }

    private suspend fun enterOffline(cached: ShiftEntity) = db.recovery.commit { enterOfflineOwned(cached) }

    private suspend fun enterOfflineOwned(cached: ShiftEntity) {
        app.markiro.handheld.core.replacement.ReplacementReadiness(db).requireAdmission("shift", cached.id)
        val now = clock()
        db.recovery.commit {
            if(cached.enteredAt == null) db.grants.start(TaskKind.SHIFT,cached.id,"shift.enter:${cached.id}")
            db.shiftDao().upsert(cached.copy(enteredAt = now, leftAt = null))
            db.deviceConfigDao().get()?.let { db.deviceConfigDao().upsert(it.copy(activeShiftId = cached.id)) }
        }
    }

    suspend fun leave(shiftId: String) {
        // A cloud backend answers `cloudApi()`; the host does not. Only a host has a slot to free.
        val owesHost = backend.cloudApi() == null
        val marker = db.recovery.commit {
            leaveOwned(shiftId)
            // Written with the local mark: a crash or a blocked recovery between the two never loses a leave the host is owed.
            if (owesHost) participation.markLeavePending(shiftId) else null
        }
        if (marker != null) releaseSlot(shiftId, marker)
    }

    /**
     * Best effort and after the local mark, which is what the operator sees; production data is never touched. Only what the host SETTLED clears the
     * marker (compare-and-clear on the one written above, so a pause asked again meanwhile stays owed): an answer whose part is `left` or `closed`,
     * or a definite refusal (`shift_not_entered`, `not_found`, `validation_failed`). An answer that still says `active` means the host no-oped a stale
     * token (an automatic rejoin re-entered the part): the leave stays owed and the heartbeat sends it again with the fresh token. An answer that names
     * no state (`null`: no host call was made) settles nothing either (final review C1). Anything else (unreachable, a timeout, a 5xx) stays owed too.
     */
    private suspend fun releaseSlot(shiftId: String, marker: String) {
        try {
            val state = db.recovery.work { backend.leave(shiftId) }
            if (state == "left" || state == "closed") participation.clearLeavePending(shiftId, marker)
        } catch (e: HttpException) {
            if (app.markiro.handheld.core.host.OwedLeaveRefusals.settles(e)) participation.clearLeavePending(shiftId, marker)
        } catch (e: IOException) {
            if (app.markiro.handheld.core.host.OwedLeaveRefusals.settles(e)) participation.clearLeavePending(shiftId, marker)
        } catch (_: app.markiro.handheld.core.storage.RecoveryBlocked) {
            // The device is being paired again: the marker goes with the dataset if that replaces it, and stays owed otherwise.
        }
    }

    /**
     * A local mark only. The hub card and the list's «Продолжить» follow
     * `activeShiftId`, so it goes with the shift (as `ShiftCloser` and the
     * inventory leave already do); the mirror row, its bundle, queued scans and
     * unprinted boxes stay for the sync engines and a later re-entry.
     */
    private suspend fun leaveOwned(shiftId: String) {
        db.shiftDao().setLeftAt(shiftId, clock())
        db.deviceConfigDao().get()?.let { if (it.activeShiftId == shiftId) db.deviceConfigDao().upsert(it.copy(activeShiftId = null)) }
    }

    /** The body is read once (a response body can be consumed only once): the code and, for a full line, its two numbers. */
    private fun errorBody(e: HttpException): ErrorBody? =
        runCatching { json.decodeFromString(ErrorBody.serializer(), e.response()?.errorBody()?.string().orEmpty()) }.getOrNull()
}
