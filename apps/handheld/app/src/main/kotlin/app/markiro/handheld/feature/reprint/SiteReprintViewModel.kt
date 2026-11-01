package app.markiro.handheld.feature.reprint

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.core.reprint.SiteReprintJob
import app.markiro.handheld.core.reprint.SiteReprintOperations
import app.markiro.handheld.core.reprint.SiteReprintResult
import app.markiro.handheld.core.scan.ScanEvents
import app.markiro.handheld.core.signal.SignalKind
import app.markiro.handheld.core.signal.Signaller
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.RecoveryPhase
import app.markiro.handheld.core.storage.RecoveryState
import app.markiro.handheld.feature.signin.SessionHolder
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import java.util.UUID
import javax.inject.Inject

enum class SiteReprintStep { LOADING, REASON, SCAN, MANUAL, VERIFY }

data class SiteReprintUi(
    val step: SiteReprintStep = SiteReprintStep.LOADING,
    val reason: String? = null,
    val busy: Boolean = false,
    val busyScan: Boolean = false,
    val result: SiteReprintResult? = null,
    val pendingJobId: String? = null,
    val sealed: Boolean = false,
    val problem: String? = null,
    val catalogUnavailable: Boolean = false,
)

/** Scanner ownership and UI session are independent of the durable print job. */
@HiltViewModel
class SiteReprintViewModel internal constructor(
    private val operations: SiteReprintOperations,
    private val session: SessionHolder,
    scans: ScanEvents,
    private val recovery: StateFlow<RecoveryState>,
    private val signal: (SignalKind) -> Unit,
) : ViewModel() {
    @Inject constructor(
        operations: SiteReprintOperations,
        session: SessionHolder,
        scans: ScanEvents,
        db: HandheldDatabase,
        signaller: Signaller,
    ) : this(operations, session, scans, db.recovery.state, signaller::play)

    private data class Binding(val operator: String, val recovery: RecoveryState)
    private val mutable = MutableStateFlow(SiteReprintUi())
    val state: StateFlow<SiteReprintUi> = mutable
    private var binding: Binding? = null
    private var revision = 0L
    private var sessionId = UUID.randomUUID().toString()
    private var active = false
    private var lastRaw: String? = null

    init {
        viewModelScope.launch {
            combine(session.state, recovery) { _, _ -> currentBinding() }.collect { next ->
                if (binding != next || (next == null && mutable.value.step == SiteReprintStep.LOADING)) {
                    revision++
                    binding = next
                    sessionId = UUID.randomUUID().toString()
                    lastRaw = null
                    mutable.value = SiteReprintUi(step = if (next == null) SiteReprintStep.REASON else SiteReprintStep.LOADING,
                        sealed = next == null, problem = if (next == null) "operator_changed" else null)
                    if (next != null) initialize(next, revision)
                }
            }
        }
        viewModelScope.launch {
            scans.events.collect { event ->
                if (active && mutable.value.step in setOf(SiteReprintStep.SCAN, SiteReprintStep.VERIFY)) submit(event.raw)
            }
        }
    }

    private fun currentBinding(): Binding? {
        val operator = session.state.value.takeUnless { it.locked }?.operator?.operatorId ?: return null
        return recovery.value.takeIf { it.phase == RecoveryPhase.ACTIVE && it.owner != null }?.let { Binding(operator, it) }
    }
    private fun valid(origin: Binding, version: Long) = revision == version && binding == origin && currentBinding() == origin

    private fun initialize(origin: Binding, version: Long) {
        viewModelScope.launch {
            try {
                val pending = operations.pending()
                if (!valid(origin, version)) return@launch
                mutable.value = if (pending == null) SiteReprintUi(step = SiteReprintStep.REASON, catalogUnavailable = mutable.value.catalogUnavailable)
                else SiteReprintUi(step = SiteReprintStep.SCAN, reason = pending.reason,
                    result = pendingResult(pending), pendingJobId = pending.jobId, catalogUnavailable = mutable.value.catalogUnavailable,
                    sealed = pending.operatorId != origin.operator,
                    problem = if (pending.operatorId != origin.operator) "pending_other_operator" else null)
                if (pending?.operatorId == origin.operator) sessionId = pending.sessionId
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) {
                if (valid(origin, version)) mutable.value = SiteReprintUi(step = SiteReprintStep.SCAN, sealed = true, problem = "saved_unreadable")
            }
        }
        // Settings read this shared catalogue. A failed refresh must not block selecting a reason.
        viewModelScope.launch {
            try { operations.refreshTemplates() }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { if (valid(origin, version)) mutable.value = mutable.value.copy(catalogUnavailable = true) }
        }
        flushAudit()
    }

    fun setActive(value: Boolean) { active = value }
    fun selectReason(reason: String) {
        if (mutable.value.step == SiteReprintStep.REASON && !mutable.value.sealed && reason in REASONS) mutable.value = mutable.value.copy(reason = reason)
    }
    fun beginScanning() {
        val at = mutable.value
        if (at.step == SiteReprintStep.REASON && at.reason in REASONS && currentBinding() == binding && !at.sealed) mutable.value = at.copy(step = SiteReprintStep.SCAN)
    }
    fun backToReason() {
        if (mutable.value.busy || mutable.value.pendingJobId != null || mutable.value.sealed) return
        mutable.value = mutable.value.copy(step = SiteReprintStep.REASON, result = null, problem = null)
    }
    fun openManual() {
        if (mutable.value.step == SiteReprintStep.SCAN && !mutable.value.busy && mutable.value.pendingJobId == null && !mutable.value.sealed) mutable.value = mutable.value.copy(step = SiteReprintStep.MANUAL)
    }
    fun closeManual() { if (mutable.value.step == SiteReprintStep.MANUAL && !mutable.value.busy) mutable.value = mutable.value.copy(step = SiteReprintStep.SCAN) }

    fun submit(raw: String) {
        val at = mutable.value
        if (!active || currentBinding() != binding || at.sealed) return
        if (at.busy) {
            mutable.value = at.copy(busyScan = true)
            signal(SignalKind.ERROR)
            return
        }
        if (at.step == SiteReprintStep.VERIFY) {
            val job = at.pendingJobId ?: return
            perform(verification = true) { op -> operations.verify(job, raw, op) }
            return
        }
        if (at.step !in setOf(SiteReprintStep.SCAN, SiteReprintStep.MANUAL) || at.pendingJobId != null || raw.isBlank()) return
        if (at.result is SiteReprintResult.Failed) {
            mutable.value = at.copy(busyScan = true)
            signal(SignalKind.ERROR)
            return
        }
        val reason = at.reason?.takeIf { it in REASONS } ?: return
        lastRaw = raw
        val id = sessionId
        perform { op -> operations.print(raw, reason, id, op) }
    }

    fun retry() {
        val at = mutable.value
        if (!active || at.busy || at.sealed) return
        val job = at.pendingJobId
        if (job != null) perform { op -> operations.retry(job, op) }
        else lastRaw?.let { raw ->
            val reason = at.reason ?: return
            val id = sessionId
            perform { op -> operations.print(raw, reason, id, op) }
        }
    }
    fun startVerification() {
        val at = mutable.value
        if (!at.busy && !at.sealed && at.result is SiteReprintResult.Unknown && at.pendingJobId != null) mutable.value = at.copy(step = SiteReprintStep.VERIFY, problem = null)
    }
    fun stopVerification() {
        if (!mutable.value.busy && mutable.value.step == SiteReprintStep.VERIFY) mutable.value = mutable.value.copy(step = SiteReprintStep.SCAN, problem = null)
    }
    fun cancelJob() {
        val at = mutable.value
        if (at.busy || at.sealed || at.result !is SiteReprintResult.Failed) return
        val job = at.pendingJobId ?: return
        perform { op -> operations.cancel(job, op) }
    }

    private fun perform(verification: Boolean = false, block: suspend (String) -> SiteReprintResult) {
        val origin = binding ?: return
        val version = revision
        if (!valid(origin, version) || mutable.value.busy) return
        val previous = mutable.value
        mutable.value = previous.copy(busy = true, busyScan = false, problem = null)
        viewModelScope.launch {
            val result = try { block(origin.operator) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { SiteReprintResult.Unavailable("unavailable") }
            if (!valid(origin, version)) return@launch
            // Read durable state after any unexpected failure. Never unblock a job whose send might have begun.
            val pending = try { operations.pending() }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) {
                if (valid(origin, version)) mutable.value = mutable.value.copy(busy = false, sealed = true, problem = "saved_unreadable")
                return@launch
            }
            if (!valid(origin, version)) return@launch
            val mismatch = verification && result is SiteReprintResult.Failed && result.code == "verification_mismatch"
            val shown = if (mismatch) previous.result else pending?.let(::pendingResult) ?: result
            val jobId = pending?.jobId ?: when (shown) {
                is SiteReprintResult.Unknown -> shown.jobId
                is SiteReprintResult.Failed -> shown.jobId
                else -> null
            }
            mutable.value = mutable.value.copy(step = if (mismatch) SiteReprintStep.VERIFY else SiteReprintStep.SCAN,
                busy = false, result = shown, pendingJobId = jobId,
                sealed = pending?.operatorId?.let { it != origin.operator } ?: false,
                problem = if (mismatch) "verification_mismatch" else null)
            if (result is SiteReprintResult.Printed || result is SiteReprintResult.Cancelled) {
                lastRaw = null
                signal(SignalKind.OK)
            } else signal(SignalKind.ERROR)
            flushAudit()
        }
    }
    private fun flushAudit() {
        viewModelScope.launch {
            try { operations.flushAudit() }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { /* Durable audit remains owed; this never changes a physical print result. */ }
        }
    }
    private fun pendingResult(job: SiteReprintJob): SiteReprintResult =
        if (job.state in setOf("unknown", "sending")) SiteReprintResult.Unknown(job.jobId, "")
        else SiteReprintResult.Failed(job.error ?: "pending_print", job.jobId)

    companion object { val REASONS = listOf("not_printed", "damaged", "lost") }
}
