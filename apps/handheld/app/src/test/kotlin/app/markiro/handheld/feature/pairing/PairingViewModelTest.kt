package app.markiro.handheld.feature.pairing

import app.markiro.handheld.MainDispatcherRule
import app.markiro.handheld.core.network.CredentialDto
import app.markiro.handheld.core.network.DeviceDto
import app.markiro.handheld.core.network.LineDto
import app.markiro.handheld.core.network.PairResponse
import app.markiro.handheld.core.network.PairingError
import app.markiro.handheld.core.network.PairingGateway
import app.markiro.handheld.core.network.PairingResult
import app.markiro.handheld.core.scan.ScanEvent
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class PairingViewModelTest {
    @get:Rule
    val main = MainDispatcherRule()

    private val scans = MutableSharedFlow<ScanEvent>(extraBufferCapacity = 4)
    private val persisted = mutableListOf<Pair<PairResponse, String>>()
    private val store = ProvisioningStore { response, url -> persisted += response to url }
    private val response = PairResponse(
        DeviceDto("dev-1", "ТСД 1", "handheld", "t-1", "ООО «Родник»", LineDto("line-2", "Линия 2")),
        CredentialDto("mk_live_abc", "https://admin.markiro.app"),
        emptyList(),
    )

    private fun viewModel(redeem: suspend (String, String) -> PairingResult): PairingViewModel {
        val gateway = object : PairingGateway {
            override suspend fun redeem(serverUrl: String, code: String) = redeem(serverUrl, code)
        }
        return main.track(
            PairingViewModel(gateway, store, scans, initialServerUrl = "https://admin.markiro.app", serverEditable = false),
        )
    }

    @Test
    fun collectsEightDigitsThenPairsAndPersists() = runTest {
        val calls = mutableListOf<String>()
        val vm = viewModel { _, code ->
            calls += code
            PairingResult.Success(response)
        }
        "4812481".forEach { vm.onDigit(it) }
        vm.onConfirm()
        assertTrue(vm.state.value is PairingUi.Enter)
        vm.onDigit('2')
        vm.onConfirm()
        advanceUntilIdle()
        assertEquals(listOf("48124812"), calls)
        assertEquals(PairingUi.Success("ООО «Родник»", "Линия 2"), vm.state.value)
        assertEquals(listOf(response to "https://admin.markiro.app"), persisted)
    }

    @Test
    fun aScannedEightDigitCodeIsRedeemedDirectly() = runTest {
        val vm = viewModel { _, _ -> PairingResult.Success(response) }
        advanceUntilIdle()
        scans.tryEmit(ScanEvent("12345678", null, "debug", 0))
        advanceUntilIdle()
        assertTrue(vm.state.value is PairingUi.Success)
    }

    @Test
    fun failuresAreShownAndRetryReturnsToAnEmptyEntry() = runTest {
        val vm = viewModel { _, _ -> PairingResult.Failure(PairingError.KIND_MISMATCH) }
        "11111111".forEach { vm.onDigit(it) }
        vm.onConfirm()
        advanceUntilIdle()
        assertEquals(PairingUi.Failed(PairingError.KIND_MISMATCH), vm.state.value)
        vm.retry()
        assertEquals(PairingUi.Enter("", "https://admin.markiro.app", false), vm.state.value)
        assertTrue(persisted.isEmpty())
    }

    @Test
    fun backspaceEditsTheCodeAndAllowsAtMostEightDigits() = runTest {
        val vm = viewModel { _, _ -> PairingResult.Failure(PairingError.INVALID) }
        "123456789".forEach { vm.onDigit(it) }
        vm.onBackspace()
        assertEquals("1234567", (vm.state.value as PairingUi.Enter).code)
    }
}
