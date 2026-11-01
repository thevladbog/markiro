package app.markiro.handheld.feature.printer

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.core.print.CachedLabelTemplate
import app.markiro.handheld.core.print.PrintPurpose
import app.markiro.handheld.core.print.PrintTemplateStore
import app.markiro.handheld.core.print.PrinterTemplateChoice
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.feature.hub.RosterRefresher
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class PrinterTemplatesUi(
    val catalog: List<CachedLabelTemplate> = emptyList(),
    val choices: List<PrinterTemplateChoice> = emptyList(),
    val loading: Boolean = true,
    val hostMode: Boolean = false,
    val refreshing: Boolean = false,
    val refreshFailed: Boolean = false,
    val saveFailed: Boolean = false,
    val saved: Boolean = false,
) {
    fun chosen(printerId: String, purpose: PrintPurpose): String? =
        choices.firstOrNull { it.printerId == printerId && it.purpose == purpose.wire }?.templateId
}

@HiltViewModel
class PrinterTemplatesViewModel @Inject constructor(
    private val db: HandheldDatabase,
    private val refresher: RosterRefresher,
) : ViewModel() {
    private val local = MutableStateFlow(PrinterTemplatesUi())
    private val savedSignal = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val savedEvents = savedSignal.asSharedFlow()
    val state = combine(db.printTemplateDao().observeCatalog(), db.printTemplateDao().observeChoices(), db.deviceConfigDao().observe(), local) { catalog, choices, config, ui ->
        ui.copy(catalog = catalog, choices = choices, loading = false, hostMode = config?.backend == "host")
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), PrinterTemplatesUi())

    fun beginChoice() = local.update { it.copy(saved = false, saveFailed = false) }

    fun save(printerId: String, purpose: PrintPurpose, templateId: String?, expectedSpec: String? = null) {
        viewModelScope.launch {
            db.recovery.work {
                val saved = PrintTemplateStore(db).select(printerId, purpose, templateId, expectedSpec)
                local.update { it.copy(saved = saved, saveFailed = !saved) }
                if (saved) savedSignal.emit(Unit)
            }
        }
    }

    fun refresh() {
        if (local.value.refreshing || !state.value.hostMode) return
        local.update { it.copy(refreshing = true, refreshFailed = false) }
        viewModelScope.launch {
            val ok = refresher.refresh()
            local.update { it.copy(refreshing = false, refreshFailed = !ok) }
        }
    }
}
