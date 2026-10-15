package app.markiro.handheld.feature.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.core.sync.SyncDriver
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

data class HostQueueUi(val items: List<HostQueueItem> = emptyList()) {
    val waiting: List<HostQueueItem> get() = items.filter { !it.quarantined }
    val quarantined: List<HostQueueItem> get() = items.filter { it.quarantined }
}

/** The text of a record for support, with the name a file would have: handed to the system's share sheet by the screen. */
data class SupportExport(val fileName: String, val text: String)

@HiltViewModel
class HostQueueViewModel @Inject constructor(
    private val source: HostQueueSource,
    private val sync: SyncDriver,
) : ViewModel() {
    val state: StateFlow<HostQueueUi> = source.observe().map { HostQueueUi(it) }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), HostQueueUi())

    private val _exports = MutableSharedFlow<SupportExport>(extraBufferCapacity = 1)
    val exports: SharedFlow<SupportExport> = _exports

    /** «Отправить сейчас»: wakes the loop; a host that does not answer leaves everything where it is. */
    fun sendNow() = sync.nudge()

    /** «Передать в поддержку»: the record as frozen. */
    fun exportForSupport(recordId: String) {
        viewModelScope.launch {
            val body = source.exportBody(recordId) ?: return@launch
            _exports.emit(SupportExport("markiro-host-record-${recordId.take(8)}.json", body))
        }
    }
}
