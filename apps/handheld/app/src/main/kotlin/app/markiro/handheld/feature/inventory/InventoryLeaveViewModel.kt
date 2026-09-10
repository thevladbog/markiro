package app.markiro.handheld.feature.inventory

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.core.inventory.InventorySyncEngine
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

sealed interface LeaveStep {
    data class Draining(val pending: Int) : LeaveStep
    data class Offline(val pending: Int) : LeaveStep
    data object Failed : LeaveStep
    data object Left : LeaveStep
}

/** Drain the outbox, then `POST leave`; the server refuses a leave with queued events, so offline the task stays active. */
@HiltViewModel
class InventoryLeaveViewModel(
    handle: SavedStateHandle,
    private val repository: InventoryGateway,
    private val drain: suspend () -> Boolean,
) : ViewModel() {
    @Inject
    constructor(handle: SavedStateHandle, repository: InventoryGateway, sync: InventorySyncEngine) : this(handle, repository, { sync.drainAll() })

    val inventoryId: String = checkNotNull(handle["inventoryId"])
    private val _step = MutableStateFlow<LeaveStep>(LeaveStep.Draining(0))
    val step: StateFlow<LeaveStep> = _step

    init {
        viewModelScope.launch {
            _step.value = try {
                _step.value = LeaveStep.Draining(repository.queued(inventoryId))
                drain()
                when (val result = repository.leave(inventoryId)) {
                    LeaveResult.Left -> LeaveStep.Left
                    is LeaveResult.Pending -> LeaveStep.Offline(result.queued)
                    LeaveResult.Offline -> LeaveStep.Offline(repository.queued(inventoryId))
                    LeaveResult.Failed -> LeaveStep.Failed
                }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // Anything the gateway did not classify (a storage error, a parser) must not leave the screen on «draining».
                LeaveStep.Failed
            }
        }
    }
}
