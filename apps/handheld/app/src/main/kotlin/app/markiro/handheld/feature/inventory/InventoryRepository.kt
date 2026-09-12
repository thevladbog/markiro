package app.markiro.handheld.feature.inventory

import app.markiro.handheld.core.inventory.InventoryBundleMirror
import app.markiro.handheld.core.inventory.MirrorResult
import app.markiro.handheld.core.network.ErrorBody
import app.markiro.handheld.core.network.InventoryManifestDto
import app.markiro.handheld.core.network.InventoryTaskDto
import app.markiro.handheld.core.network.JoinInventoryRequest
import app.markiro.handheld.core.network.LeaveInventoryRequest
import app.markiro.handheld.core.network.ResolveTaskRequest
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.InventoryTaskEntity
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.json.Json
import retrofit2.HttpException
import java.io.IOException

sealed interface JoinResult {
    data class Ok(val manifest: InventoryManifestDto) : JoinResult
    data object NotRunning : JoinResult
    data object OperatorUnavailable : JoinResult
    data object LineRequired : JoinResult
    data object ConfirmationRequired : JoinResult
    data object Unavailable : JoinResult
}

sealed interface LeaveResult {
    data object Left : LeaveResult
    data class Pending(val queued: Int) : LeaveResult
    data object Offline : LeaveResult
    data object Failed : LeaveResult
}

data class ResolvedTask(val task: InventoryTaskDto, val requiresConfirmation: Boolean)

/** What the screens need; the repository implements it and tests fake it. */
interface InventoryGateway {
    fun observeTasks(): Flow<List<InventoryTaskEntity>>
    suspend fun listTasks(scope: String?): List<InventoryTaskDto>

    /** Null when the barcode is not a task barcode (404). */
    suspend fun resolveBarcode(barcode: String): ResolvedTask?
    suspend fun join(task: InventoryTaskDto, operatorId: String, confirmDifferentLine: Boolean, barcode: String?): JoinResult
    suspend fun manifest(inventoryId: String): InventoryManifestDto
    suspend fun download(manifest: InventoryManifestDto, onProgress: suspend (staged: Int, total: Int) -> Unit): MirrorResult
    suspend fun activate(inventoryId: String)
    suspend fun leave(inventoryId: String): LeaveResult
    suspend fun queued(inventoryId: String): Int
}

class InventoryRepository(
    private val api: StationApi,
    private val db: HandheldDatabase,
    private val mirror: InventoryBundleMirror,
    private val json: Json,
    private val clock: () -> Long = System::currentTimeMillis,
) : InventoryGateway {
    override fun observeTasks(): Flow<List<InventoryTaskEntity>> = db.inventoryTaskDao().observeAll()

    override suspend fun listTasks(scope: String?): List<InventoryTaskDto> = api.inventoryTasks(scope).items

    override suspend fun resolveBarcode(barcode: String): ResolvedTask? = try {
        val r = api.resolveInventoryBarcode(ResolveTaskRequest(barcode))
        ResolvedTask(r.task, r.requiresDifferentLineConfirmation)
    } catch (e: HttpException) {
        if (e.code() == 404) null else throw e
    }

    override suspend fun join(task: InventoryTaskDto, operatorId: String, confirmDifferentLine: Boolean, barcode: String?): JoinResult = db.recovery.work { joinOwned(task, operatorId, confirmDifferentLine, barcode) }

    private suspend fun joinOwned(task: InventoryTaskDto, operatorId: String, confirmDifferentLine: Boolean, barcode: String?): JoinResult = try {
        JoinResult.Ok(api.joinInventory(task.inventoryId, JoinInventoryRequest(operatorId, barcode, confirmDifferentLine.takeIf { it })).copy(recoveryGeneration = app.markiro.handheld.core.storage.DeviceRecovery.generationContext.get()))
    } catch (e: HttpException) {
        when (errorCode(e)) {
            "INVENTORY_NOT_RUNNING" -> JoinResult.NotRunning
            "INVENTORY_OPERATOR_UNAVAILABLE" -> JoinResult.OperatorUnavailable
            "INVENTORY_DEVICE_LINE_REQUIRED" -> JoinResult.LineRequired
            "INVENTORY_DIFFERENT_LINE_CONFIRMATION_REQUIRED", "INVENTORY_TASK_BARCODE_REQUIRED" -> JoinResult.ConfirmationRequired
            else -> if (e.code() == 404) JoinResult.NotRunning else JoinResult.Unavailable
        }
    } catch (_: IOException) {
        JoinResult.Unavailable
    }

    override suspend fun manifest(inventoryId: String): InventoryManifestDto = db.recovery.work {
        api.inventoryManifest(inventoryId).copy(recoveryGeneration = app.markiro.handheld.core.storage.DeviceRecovery.generationContext.get())
    }

    override suspend fun download(manifest: InventoryManifestDto, onProgress: suspend (Int, Int) -> Unit): MirrorResult = db.recovery.work { downloadOwned(manifest, onProgress) }

    private suspend fun downloadOwned(manifest: InventoryManifestDto, onProgress: suspend (Int, Int) -> Unit): MirrorResult =
        if (manifest.recoveryGeneration?.let { db.recovery.valid(it) } != true) throw app.markiro.handheld.core.storage.RecoveryBlocked()
        else mirror.mirror(manifest, onProgress)

    override suspend fun activate(inventoryId: String) = db.recovery.commit { activateOwned(inventoryId) }

    private suspend fun activateOwned(inventoryId: String) {
        val now = clock()
        db.recovery.commit {
            db.inventoryTaskDao().setJoinedAt(inventoryId, now)
            db.deviceConfigDao().get()?.let { db.deviceConfigDao().upsert(it.copy(activeInventoryId = inventoryId)) }
        }
    }

    /** The server refuses a leave with queued events; the caller drains first. */
    override suspend fun leave(inventoryId: String): LeaveResult = db.recovery.work { leaveOwned(inventoryId) }

    private suspend fun leaveOwned(inventoryId: String): LeaveResult {
        val queued = db.inventoryOutboxDao().count(inventoryId)
        if (queued > 0) return LeaveResult.Pending(queued)
        return try {
            val response = api.leaveInventory(inventoryId, LeaveInventoryRequest(0, 0))
            if (response.outcome != "left") return LeaveResult.Failed
            val now = clock()
            db.recovery.commit {
                db.inventoryTaskDao().setLeftAt(inventoryId, now)
                db.deviceConfigDao().get()?.let {
                    if (it.activeInventoryId == inventoryId) db.deviceConfigDao().upsert(it.copy(activeInventoryId = null))
                }
            }
            LeaveResult.Left
        } catch (_: IOException) {
            LeaveResult.Offline
        } catch (_: HttpException) {
            LeaveResult.Failed
        }
    }

    override suspend fun queued(inventoryId: String): Int = db.inventoryOutboxDao().count(inventoryId)

    private fun errorCode(e: HttpException): String? =
        runCatching { json.decodeFromString(ErrorBody.serializer(), e.response()?.errorBody()?.string().orEmpty()).code }.getOrNull()
}
