package app.markiro.handheld.feature.writeoff

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.core.network.WriteoffSettlementDto
import app.markiro.handheld.core.storage.WriteoffOutboxEntity
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.serialization.json.Json
import javax.inject.Inject

/** One filed document as the history screen shows it. */
data class WriteoffHistoryRow(
    val documentId: String,
    val reasonName: String,
    val createdAt: String,
    val state: String,
    val orderNo: String?,
    val unitCount: Int,
    val boxCount: Int,
    val acceptedCount: Int?,
    /** How many lines the server refused; null while the document is still queued. */
    val rejectedCount: Int?,
    val error: String?,
)

/**
 * The last twenty documents this device filed, with their sync state. Offline it
 * is the only record of what has already been written off from this terminal.
 * It is a display, never consulted when deciding whether a fresh scan repeats.
 */
@HiltViewModel
class WriteoffHistoryViewModel @Inject constructor(
    gateway: WriteoffGateway,
) : ViewModel() {
    val rows: StateFlow<List<WriteoffHistoryRow>> = gateway.observeRecent()
        .map { rows -> rows.map { it.toRow() } }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    private fun WriteoffOutboxEntity.toRow(): WriteoffHistoryRow {
        val settlement = conflictsJson?.let {
            runCatching { Json.decodeFromString(WriteoffSettlementDto.serializer(), it) }.getOrNull()
        }
        val rejected = settlement?.let { it.conflicts.size + it.boxConflicts.size }
        return WriteoffHistoryRow(
            documentId = documentId, reasonName = reasonName, createdAt = createdAt, state = state, orderNo = orderNo,
            unitCount = unitCount, boxCount = boxCount, acceptedCount = acceptedCount, rejectedCount = rejected,
            error = settlement?.error,
        )
    }
}
