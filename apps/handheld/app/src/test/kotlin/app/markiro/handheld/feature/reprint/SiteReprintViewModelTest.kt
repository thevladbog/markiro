package app.markiro.handheld.feature.reprint

import app.markiro.handheld.MainDispatcherRule
import app.markiro.handheld.core.auth.OperatorRecord
import app.markiro.handheld.core.reprint.*
import app.markiro.handheld.core.scan.*
import app.markiro.handheld.core.signal.SignalKind
import app.markiro.handheld.core.storage.*
import app.markiro.handheld.feature.signin.SessionHolder
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class SiteReprintViewModelTest {
    @get:Rule val main = MainDispatcherRule()
    private val session = SessionHolder().apply { signIn(operator("operator")) }
    private val scans = MutableSharedFlow<ScanEvent>(extraBufferCapacity = 4)
    private val recovery = MutableStateFlow(RecoveryState(RecoveryPhase.ACTIVE, DeviceOwner("https://host", "host", "device", "handheld", "a".repeat(64)), 1))
    private val signals = mutableListOf<SignalKind>()
    private class Operations : SiteReprintOperations {
        val prints = mutableListOf<List<String>>()
        val retries = mutableListOf<String>()
        val verifications = mutableListOf<String>()
        var saved: SiteReprintJob? = null
        var answer: suspend () -> SiteReprintResult = { SiteReprintResult.Printed("job", "Original product") }
        var refreshFails = false
        override suspend fun print(raw: String, reason: String, sessionId: String, operatorId: String): SiteReprintResult { prints += listOf(raw, reason, sessionId, operatorId); return answer() }
        override suspend fun retry(jobId: String, operatorId: String): SiteReprintResult { retries += jobId; return answer() }
        override suspend fun verify(jobId: String, raw: String, operatorId: String): SiteReprintResult { verifications += raw; return answer() }
        override suspend fun cancel(jobId: String, operatorId: String): SiteReprintResult { saved = null; return SiteReprintResult.Cancelled(jobId) }
        override suspend fun pending() = saved
        override suspend fun refreshTemplates() { if (refreshFails) error("offline") }
        override suspend fun flushAudit() = Unit
    }
    private fun model(operations: Operations) = main.track(SiteReprintViewModel(operations, session, ScanRouterAdapter(scans), recovery, signals::add)).also { it.setActive(true) }
    private suspend fun scan(raw: String = "046800899000000017") = scans.emit(ScanEvent(raw, null, "test", 0))
    private fun ready(vm: SiteReprintViewModel) { vm.selectReason("damaged"); vm.beginScanning() }

    @Test fun reasonIsRequiredAndEveryScanImmediatelyPrintsWithoutLosingTheSession() = runTest {
        val operations = Operations(); val vm = model(operations); runCurrent()
        vm.beginScanning(); scan(); runCurrent(); assertTrue(operations.prints.isEmpty())
        ready(vm); scan(); runCurrent(); scan("146800899000000015"); runCurrent()
        assertEquals(2, operations.prints.size)
        assertEquals(operations.prints[0][2], operations.prints[1][2])
        assertEquals("damaged", vm.state.value.reason)
        assertEquals(SiteReprintStep.SCAN, vm.state.value.step)
        assertTrue(vm.state.value.result is SiteReprintResult.Printed)
    }
    @Test fun settingsSuspendScannerAndPreserveReasonAndSession() = runTest {
        val operations = Operations(); val vm = model(operations); runCurrent(); ready(vm)
        vm.backToReason(); vm.setActive(false); scan(); runCurrent(); assertTrue(operations.prints.isEmpty())
        vm.setActive(true); runCurrent(); assertEquals("damaged", vm.state.value.reason)
        vm.beginScanning(); scan(); runCurrent(); assertEquals(1, operations.prints.size)
    }
    @Test fun busyScanIsAcknowledgedAndNeverQueuedOrPrintedTwice() = runTest {
        val operations = Operations(); val answer = CompletableDeferred<SiteReprintResult>(); operations.answer = { answer.await() }
        val vm = model(operations); runCurrent(); ready(vm); scan(); runCurrent(); scan("other"); runCurrent()
        assertEquals(1, operations.prints.size); assertTrue(vm.state.value.busyScan); assertTrue(signals.contains(SignalKind.ERROR))
        answer.complete(SiteReprintResult.Printed("job", "Original")); runCurrent(); assertFalse(vm.state.value.busy)
    }
    @Test fun manualInputUsesTheSameImmediatePrintOperation() = runTest {
        val operations = Operations(); val vm = model(operations); runCurrent(); ready(vm); vm.openManual(); vm.submit("manual-code"); runCurrent()
        assertEquals("manual-code", operations.prints.single()[0]); assertEquals(SiteReprintStep.SCAN, vm.state.value.step)
    }
    @Test fun unknownVerificationNeverPrintsANewObjectAndMismatchKeepsVerificationActive() = runTest {
        val operations = Operations().apply { answer = { SiteReprintResult.Unknown("job", "Original") } }
        val vm = model(operations); runCurrent(); ready(vm); scan(); runCurrent()
        scan("ignored"); runCurrent(); assertEquals(1, operations.prints.size)
        vm.startVerification(); operations.answer = { SiteReprintResult.Failed("verification_mismatch", "job") }
        scan("wrong"); runCurrent(); assertEquals(listOf("wrong"), operations.verifications)
        assertEquals(SiteReprintStep.VERIFY, vm.state.value.step); assertTrue(vm.state.value.result is SiteReprintResult.Unknown)
        operations.answer = { SiteReprintResult.Printed("job", "Original") }; scan(); runCurrent()
        assertEquals(SiteReprintStep.SCAN, vm.state.value.step); assertEquals(1, operations.prints.size)
    }
    @Test fun lateResultCannotRepopulateLockedOrChangedOperatorSession() = runTest {
        val operations = Operations(); val answer = CompletableDeferred<SiteReprintResult>(); operations.answer = { answer.await() }
        val vm = model(operations); runCurrent(); ready(vm); scan(); runCurrent(); session.lock(); runCurrent()
        answer.complete(SiteReprintResult.Printed("job", "Old operator")); runCurrent(); assertNull(vm.state.value.result); assertNull(vm.state.value.reason)
        session.signIn(operator("another")); runCurrent(); assertEquals(SiteReprintStep.REASON, vm.state.value.step)
    }
    @Test fun generationChangeInvalidatesSessionAndTemplateRefreshFailureIsAHint() = runTest {
        val operations = Operations().apply { refreshFails = true }; val vm = model(operations); runCurrent(); ready(vm)
        assertTrue(vm.state.value.catalogUnavailable)
        recovery.value = recovery.value.copy(generation = 2); runCurrent()
        assertNull(vm.state.value.reason); assertEquals(SiteReprintStep.REASON, vm.state.value.step)
    }
    @Test fun restoredJobRetainsItsReasonAndNeverAdoptsAnotherOperatorsJob() = runTest {
        val operations = Operations().apply { saved = savedJob("other") }; val vm = model(operations); runCurrent()
        assertEquals("lost", vm.state.value.reason); assertTrue(vm.state.value.sealed)
        vm.retry(); vm.startVerification(); vm.submit("other-code"); runCurrent()
        assertTrue(operations.prints.isEmpty()); assertTrue(operations.retries.isEmpty()); assertTrue(operations.verifications.isEmpty())
    }
    @Test fun restoredDefiniteFailureIsNotSentAutomaticallyAndCanBeCancelledExplicitly() = runTest {
        val operations = Operations().apply { saved = savedJob("operator").copy(state = "failed", error = "no_paper") }
        val vm = model(operations); runCurrent()
        assertEquals("lost", vm.state.value.reason); assertFalse(vm.state.value.sealed)
        assertTrue(operations.prints.isEmpty()); assertTrue(operations.retries.isEmpty())
        scan(); runCurrent(); assertTrue(operations.prints.isEmpty())
        vm.cancelJob(); runCurrent()
        assertTrue(vm.state.value.result is SiteReprintResult.Cancelled)
        assertNull(vm.state.value.pendingJobId); assertEquals("lost", vm.state.value.reason)
    }
    @Test fun unknownCanNeverBeCancelledAndExplicitRetryUsesTheSavedJob() = runTest {
        val operations = Operations().apply { answer = { SiteReprintResult.Unknown("job", "Original") } }
        val vm = model(operations); runCurrent(); ready(vm); scan(); runCurrent()
        vm.cancelJob(); runCurrent(); assertTrue(vm.state.value.result is SiteReprintResult.Unknown)
        vm.retry(); runCurrent(); assertEquals(listOf("job"), operations.retries); assertEquals(1, operations.prints.size)
    }
    @Test fun aJoblessFailureAllowsTheNextScanWhileSavedFailuresRemainBlocked() = runTest {
        val operations = Operations().apply { answer = { SiteReprintResult.Failed("printer_unconfigured") } }
        val vm = model(operations); runCurrent(); ready(vm); scan(); runCurrent()
        assertNull(vm.state.value.pendingJobId)
        operations.answer = { SiteReprintResult.Printed("next", "Product") }
        scan("next-code"); runCurrent()
        assertEquals(listOf("046800899000000017", "next-code"), operations.prints.map { it[0] })
        assertTrue(vm.state.value.result is SiteReprintResult.Printed)

        operations.saved = savedJob("operator").copy(state = "failed", error = "no_paper")
        operations.answer = { SiteReprintResult.Failed("no_paper", "job") }
        scan("saved-code"); runCurrent()
        val before = operations.prints.size
        scan("blocked-code"); runCurrent()
        assertEquals(before, operations.prints.size)
        assertEquals("job", vm.state.value.pendingJobId)
    }

    private fun savedJob(operator: String) = SiteReprintJob("job", "f52ff2b2-60dd-46b7-ac85-aad87065e8c9", "{}", 1, operator, "host", "{}", "{}", "{}", "", "lost", "unknown", null, "attempt", 1, 1, "2026-11-01T00:00:00Z", "2026-11-01T00:00:00Z")
    private fun operator(id: String) = OperatorRecord(id, "Сергей", "1001", "operator", "x", null, true)
}
