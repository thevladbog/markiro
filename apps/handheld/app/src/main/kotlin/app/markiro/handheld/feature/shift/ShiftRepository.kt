package app.markiro.handheld.feature.shift

import androidx.room.withTransaction
import app.markiro.handheld.core.box.ServerRange
import app.markiro.handheld.core.box.SsccPool
import app.markiro.handheld.core.network.ErrorBody
import app.markiro.handheld.core.network.LineDto
import app.markiro.handheld.core.network.ShiftBundleDto
import app.markiro.handheld.core.network.ShiftDto
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.network.UPDATE_REQUIRED_CODE
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.ShiftEntity
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.json.Json
import retrofit2.HttpException
import java.io.IOException

sealed interface EnterResult {
    data object Ok : EnterResult
    data object UpdateRequired : EnterResult
    data object Closed : EnterResult
    data object Unavailable : EnterResult
}

fun ShiftDto.toEntity(existing: ShiftEntity?, now: Long) = ShiftEntity(
    id = id,
    number = number,
    // A shift closed on this device stays closed even while the close is still queued and the server lists it as active.
    status = if (existing?.status == "closed") "closed" else status,
    mode = mode,
    productId = productId,
    productName = productName,
    productPrintName = productPrintName,
    productGtin14 = existing?.productGtin14,
    lineId = lineId,
    lineName = lineName,
    counterpartyName = counterpartyName,
    plannedQty = plannedQty,
    plannedDate = plannedDate,
    productionDate = productionDate,
    boxCapacity = boxCapacity,
    palletCapacity = palletCapacity,
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
    shelfLifeDays = existing?.shelfLifeDays,
    egaisCode = existing?.egaisCode,
    ssccIssuerPrefix = existing?.ssccIssuerPrefix,
)

/** Shift list cache, entry (server participation + bundle) and the local leave mark. */
class ShiftRepository(
    private val api: StationApi,
    private val db: HandheldDatabase,
    private val json: Json,
    private val pool: SsccPool,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    fun observeShifts(): Flow<List<ShiftEntity>> = db.shiftDao().observeAll()

    /** Own line plus unassigned shifts; rows without a bundle that vanished from the list are dropped. */
    suspend fun refreshList(): Boolean = try {
        val items = api.shifts().items
        val now = clock()
        db.withTransaction {
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

    suspend fun otherLines(ownLineId: String?): List<LineDto> = api.lines().items.filter { it.id != ownLineId }

    suspend fun shiftsOfLine(lineId: String): List<ShiftDto> = api.shifts(lineId = lineId).items.filter { it.status != "closed" }

    suspend fun enter(shiftId: String): EnterResult {
        val cached = db.shiftDao().get(shiftId)
        return try {
            val entered = api.enter(shiftId)
            val bundle = api.bundle(shiftId)
            val now = clock()
            applySsccBlock(bundle)
            db.withTransaction {
                db.shiftDao().upsert(
                    bundle.shift.toEntity(cached, now).copy(
                        status = entered.status,
                        productGtin14 = bundle.product.gtin14,
                        productName = bundle.product.name,
                        productPrintName = bundle.product.printName ?: bundle.shift.productPrintName,
                        boxLabelTemplate = bundle.boxLabelTemplate?.spec?.toString(),
                        shelfLifeDays = bundle.product.shelfLifeDays,
                        egaisCode = bundle.product.egaisCode,
                        ssccIssuerPrefix = bundle.sscc?.issuerPrefix,
                        bundleFetchedAt = now,
                        enteredAt = now,
                        leftAt = null,
                    ),
                )
                // As on the station, `bundle.operators` is ignored: pairing and the roster refresh are the authoritative sources.
                db.deviceConfigDao().get()?.let { db.deviceConfigDao().upsert(it.copy(activeShiftId = shiftId)) }
            }
            EnterResult.Ok
        } catch (e: HttpException) {
            when {
                e.code() == 409 && errorCode(e) == UPDATE_REQUIRED_CODE -> EnterResult.UpdateRequired
                e.code() == 409 || e.code() == 404 -> EnterResult.Closed
                else -> EnterResult.Unavailable
            }
        } catch (_: IOException) {
            if (cached?.bundleFetchedAt != null) {
                enterOffline(cached)
                EnterResult.Ok
            } else {
                EnterResult.Unavailable
            }
        }
    }

    /**
     * Revoked blocks are dropped BEFORE the new one is applied. Burning picks
     * the lowest `fromSerial` with room, so a revoked range left in place keeps
     * winning over the replacement an admin just cut, and the reseeded number
     * never reaches a label.
     *
     * Outside the shift transaction on purpose: the pool is device-wide, not
     * this shift's, and it holds its own lock.
     */
    private suspend fun applySsccBlock(bundle: ShiftBundleDto) {
        val block = bundle.sscc ?: return
        pool.dropRanges(block.issuerPrefix, block.extensionDigit, bundle.ssccRevokedFrom)
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

    private suspend fun enterOffline(cached: ShiftEntity) {
        val now = clock()
        db.withTransaction {
            db.shiftDao().upsert(cached.copy(enteredAt = now, leftAt = null))
            db.deviceConfigDao().get()?.let { db.deviceConfigDao().upsert(it.copy(activeShiftId = cached.id)) }
        }
    }

    suspend fun leave(shiftId: String) = db.shiftDao().setLeftAt(shiftId, clock())

    private fun errorCode(e: HttpException): String? =
        runCatching { json.decodeFromString(ErrorBody.serializer(), e.response()?.errorBody()?.string().orEmpty()).code }.getOrNull()
}
