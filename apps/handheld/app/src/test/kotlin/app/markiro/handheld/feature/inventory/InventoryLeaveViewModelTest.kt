package app.markiro.handheld.feature.inventory

import androidx.lifecycle.SavedStateHandle
import app.markiro.handheld.MainDispatcherRule
import app.markiro.handheld.core.inventory.MirrorResult
import app.markiro.handheld.core.network.InventoryManifestDto
import app.markiro.handheld.core.network.InventoryTaskDto
import app.markiro.handheld.core.storage.InventoryTaskEntity
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class InventoryLeaveViewModelTest {
    @get:Rule
    val main = MainDispatcherRule()

    private class Gateway(private val results: ArrayDeque<LeaveResult>, private val pending: Int) : InventoryGateway {
        override fun observeTasks(): Flow<List<InventoryTaskEntity>> = flowOf(emptyList())
        override suspend fun listTasks(scope: String?) = emptyList<InventoryTaskDto>()
        override suspend fun resolveBarcode(barcode: String): ResolvedTask? = null
        override suspend fun join(task: InventoryTaskDto, operatorId: String, confirmDifferentLine: Boolean, barcode: String?): JoinResult =
            JoinResult.Unavailable
        override suspend fun manifest(inventoryId: String): InventoryManifestDto = throw UnsupportedOperationException()
        override suspend fun download(manifest: InventoryManifestDto, onProgress: suspend (Int, Int) -> Unit): MirrorResult = MirrorResult.Active
        override suspend fun activate(inventoryId: String) = Unit
        override suspend fun leave(inventoryId: String): LeaveResult = results.removeFirst()
        override suspend fun queued(inventoryId: String) = pending
    }

    private fun vm(gateway: Gateway, drained: Boolean) =
        InventoryLeaveViewModel(SavedStateHandle(mapOf("inventoryId" to "i1")), gateway, drain = { drained })

    @Test
    fun drainsThenLeaves() = runTest {
        val vm = vm(Gateway(ArrayDeque(listOf(LeaveResult.Left)), pending = 0), drained = true)
        advanceUntilIdle()
        assertEquals(LeaveStep.Left, vm.step.value)
    }

    @Test
    fun offlineWithQueueStaysOnTheTask() = runTest {
        val vm = vm(Gateway(ArrayDeque(listOf(LeaveResult.Pending(3))), pending = 3), drained = false)
        advanceUntilIdle()
        assertEquals(LeaveStep.Offline(3), vm.step.value)
    }

    @Test
    fun aServerRefusalIsShownAsFailed() = runTest {
        val vm = vm(Gateway(ArrayDeque(listOf(LeaveResult.Failed)), pending = 0), drained = true)
        advanceUntilIdle()
        assertEquals(LeaveStep.Failed, vm.step.value)
    }

    @Test
    fun anUnexpectedFailureIsShownAsFailedToo() = runTest {
        // An empty queue makes the gateway throw from `leave`.
        val vm = vm(Gateway(ArrayDeque(), pending = 0), drained = true)
        advanceUntilIdle()
        assertEquals(LeaveStep.Failed, vm.step.value)
    }
}
