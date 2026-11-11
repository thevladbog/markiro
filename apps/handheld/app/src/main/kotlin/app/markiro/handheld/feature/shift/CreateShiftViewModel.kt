package app.markiro.handheld.feature.shift

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.core.host.HostRevocation
import app.markiro.handheld.core.network.host.HostApi
import app.markiro.handheld.core.network.host.HostApiError
import app.markiro.handheld.core.network.host.HostFailure
import app.markiro.handheld.core.network.host.HostShiftCreateRequest
import app.markiro.handheld.core.network.host.ShiftCreateOptionsDto
import app.markiro.handheld.core.network.host.ShiftCreateProductDto
import app.markiro.handheld.core.replacement.ReplacementReadiness
import app.markiro.handheld.core.scan.ScanEvents
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.feature.signin.SessionHolder
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient
import kotlinx.serialization.json.Json
import java.time.LocalDate
import java.time.ZoneId
import java.util.UUID
import javax.inject.Inject

enum class CreateShiftIssue { OFFLINE, LINE, LICENSE, CATALOG, REFUSED, ENTER, NO_MATCH, NO_PRODUCTS }

@Serializable
data class CreatedShiftLink(val id: String, val number: String)

@Serializable
private data class StoredShiftDraft(
    @Transient val options: ShiftCreateOptionsDto? = null,
    val draft: CreateShiftDraft = CreateShiftDraft(),
    val pending: HostShiftCreateRequest? = null,
    val created: CreatedShiftLink? = null,
)

data class CreateShiftUi(
    val options: ShiftCreateOptionsDto? = null,
    val draft: CreateShiftDraft = CreateShiftDraft(),
    val pending: Boolean = false,
    val created: CreatedShiftLink? = null,
    val busy: Boolean = true,
    val issue: CreateShiftIssue? = null,
)

@HiltViewModel
class CreateShiftViewModel @Inject constructor(
    private val db: HandheldDatabase,
    private val meta: MetaStore,
    private val api: HostApi,
    private val revocation: HostRevocation,
    private val repository: ShiftRepository,
    private val session: SessionHolder,
    scans: ScanEvents,
) : ViewModel() {
    private val generation = db.recovery.token()
    private val operatorId = session.state.value.operator?.operatorId
    private val json = Json { ignoreUnknownKeys = true }
    private val mutable = MutableStateFlow(CreateShiftUi())
    val state = mutable.asStateFlow()
    private val entered = Channel<String>(Channel.BUFFERED)
    val entries = entered.receiveAsFlow()
    private val persistence = Mutex()
    private var saved = StoredShiftDraft()
    private var key: String? = null
    private var productScanning = false

    init {
        launchBusy {
            val config = db.deviceConfigDao().get()
            val hostId = config?.hostId
            if (config == null || config.backend != "host" || hostId == null || operatorId == null) {
                render(CreateShiftIssue.REFUSED)
                return@launchBusy
            }
            // Repairing the same device may continue an ambiguous request. A different
            // device, host, operator or imported dataset cannot use its draft.
            val storeKey = "host_new_shift:$hostId:${config.deviceId}:${config.hostDatasetEpoch.orEmpty()}:$operatorId"
            key = storeKey
            val stored = meta.get(storeKey)?.let { json.decodeFromString(StoredShiftDraft.serializer(), it) } ?: StoredShiftDraft()
            val options = meta.get("$storeKey:options")?.let { json.decodeFromString(ShiftCreateOptionsDto.serializer(), it) }
            saved = stored.copy(options = options, draft = options?.let { withDefaultDates(stored.draft, it) } ?: stored.draft)
            render()
            if (saved.pending == null && saved.created == null) fetchOptions()
        }
        viewModelScope.launch {
            scans.events.collect { scan ->
                val options = saved.options ?: return@collect
                if (!productScanning || !editable() || !operatorActive()) return@collect
                val product = findCreateProduct(scan.raw, options.products)
                if (product == null) render(CreateShiftIssue.NO_MATCH) else select(product)
            }
        }
    }

    fun setProductScanning(active: Boolean) { productScanning = active }

    fun reload() {
        if (mutable.value.busy || key == null || saved.pending != null || saved.created != null) return
        launchBusy { fetchOptions() }
    }

    fun select(product: ShiftCreateProductDto) = edit { it.withProduct(product) }

    fun edit(change: (CreateShiftDraft) -> CreateShiftDraft) {
        if (!editable() || !operatorActive()) return
        saved = saved.copy(draft = change(saved.draft))
        render()
        viewModelScope.launch {
            try {
                db.recovery.work(generation) { persist() }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                render(CreateShiftIssue.REFUSED)
            }
        }
    }

    fun submit() {
        if (mutable.value.busy || key == null || !operatorActive()) return
        launchBusy {
            val created = saved.created ?: run {
                val request = saved.pending ?: saved.options?.let { options -> saved.draft.request(options, UUID.randomUUID().toString()) }
                    ?: return@launchBusy
                db.recovery.commit { ReplacementReadiness(db).requireAdmission() }
                saved = saved.copy(pending = request)
                // Commit the exact request before touching the network. A timeout or
                // process restart must not create a second shift on the next attempt.
                persist()
                render()
                if (!operatorActive()) return@launchBusy
                val response = api.createShift(request)
                val accepted = response.getOrElse { failure ->
                    handleFailure(failure, submitting = true)
                    return@launchBusy
                }
                val link = CreatedShiftLink(accepted.id, accepted.number)
                saved = saved.copy(pending = null, created = link)
                persist()
                render()
                link
            }
            if (!operatorActive()) return@launchBusy
            when (repository.enter(created.id)) {
                EnterResult.Ok -> {
                    clearDraft()
                    entered.send(created.id)
                }
                else -> {
                    repository.refreshList()
                    render(CreateShiftIssue.ENTER)
                }
            }
        }
    }

    fun leave(onBack: () -> Unit) {
        if (mutable.value.busy) return
        launchBusy {
            if (saved.created != null) {
                clearDraft()
            } else {
                persist()
            }
            onBack()
        }
    }

    private fun operatorActive() = session.state.value.let { !it.locked && operatorId != null && it.operator?.operatorId == operatorId }

    private fun editable() = !mutable.value.busy && saved.pending == null && saved.created == null

    private fun launchBusy(block: suspend () -> Unit) {
        mutable.update { it.copy(busy = true, issue = null) }
        viewModelScope.launch {
            try {
                db.recovery.work(generation) { if (operatorActive()) block() }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                render(if (saved.created != null) CreateShiftIssue.ENTER else CreateShiftIssue.REFUSED)
            } finally {
                mutable.update { it.copy(busy = false) }
            }
        }
    }

    private suspend fun fetchOptions() {
        val options = api.shiftCreateOptions().getOrElse { failure ->
            handleFailure(failure)
            return
        }
        var draft = withDefaultDates(saved.draft, options)
        if (draft.product(options) == null) draft = draft.copy(productId = null)
        saved = saved.copy(options = options, draft = draft)
        persistOptions()
        persist()
        render(when {
            !options.creationAllowed -> CreateShiftIssue.LICENSE
            options.products.isEmpty() -> CreateShiftIssue.NO_PRODUCTS
            else -> null
        })
    }

    private fun withDefaultDates(draft: CreateShiftDraft, options: ShiftCreateOptionsDto): CreateShiftDraft {
        if (draft.plannedDate.isNotEmpty() && draft.productionDate.isNotEmpty()) return draft
        val today = LocalDate.now(ZoneId.of(options.timeZone)).toString()
        return draft.copy(plannedDate = draft.plannedDate.ifEmpty { today }, productionDate = draft.productionDate.ifEmpty { today })
    }

    private suspend fun handleFailure(error: Throwable, submitting: Boolean = false) {
        val apiError = error as? HostApiError
        val failure = apiError?.failure
        if (failure == HostFailure.KeyRejected) revocation.reject(generation)
        // A clear business rejection means the request did not take effect.
        // A transport/5xx/invalid success reply leaves the request pinned.
        val status = apiError?.status ?: 0
        if (submitting && status in 400..499 && status !in setOf(401, 408, 429)) {
            saved = saved.copy(pending = null)
            persist()
        }
        val issue = when (failure) {
            is HostFailure.Constraint -> when (failure.name) {
                "shift_line" -> CreateShiftIssue.LINE
                "product_inactive", "lot_template_missing" -> CreateShiftIssue.CATALOG
                else -> CreateShiftIssue.REFUSED
            }
            HostFailure.LicenseRestricted, HostFailure.FeatureDisabled -> CreateShiftIssue.LICENSE
            HostFailure.Unreachable, HostFailure.Timeout, HostFailure.CertificateMismatch,
            is HostFailure.RestorePending, is HostFailure.ServerError -> CreateShiftIssue.OFFLINE
            HostFailure.BadResponse -> when (status) {
                400, 422 -> CreateShiftIssue.CATALOG
                in 200..299 -> CreateShiftIssue.OFFLINE
                else -> CreateShiftIssue.REFUSED
            }
            else -> CreateShiftIssue.REFUSED
        }
        if (issue == CreateShiftIssue.LINE && saved.pending == null) {
            saved = saved.copy(options = null)
            persistOptions()
        }
        render(issue)
    }

    private suspend fun persist() = persistence.withLock {
        key?.let { meta.put(it, json.encodeToString(StoredShiftDraft.serializer(), saved)) }
    }

    // Large catalogs are cached only when loaded, not rewritten with each keystroke.
    private suspend fun persistOptions() = persistence.withLock {
        val optionsKey = "${key ?: return@withLock}:options"
        val options = saved.options
        val encoded = options?.let { json.encodeToString(ShiftCreateOptionsDto.serializer(), it) }
        // A large online catalog must never exceed the single-row Room cursor window.
        if (encoded == null || encoded.length > 250_000) meta.remove(optionsKey)
        else meta.put(optionsKey, encoded)
    }

    private suspend fun clearDraft() = persistence.withLock {
        key?.let { meta.remove(it) }
        key = null
    }

    private fun render(issue: CreateShiftIssue? = null) {
        mutable.update {
            it.copy(options = saved.options, draft = saved.draft, pending = saved.pending != null, created = saved.created, issue = issue)
        }
    }
}
