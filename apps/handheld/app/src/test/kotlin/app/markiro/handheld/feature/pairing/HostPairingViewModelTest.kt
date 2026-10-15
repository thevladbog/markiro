package app.markiro.handheld.feature.pairing

import app.markiro.handheld.MainDispatcherRule
import app.markiro.handheld.core.network.host.HostApiError
import app.markiro.handheld.core.network.host.HostFailure
import app.markiro.handheld.core.network.host.HelloDto
import app.markiro.handheld.core.network.host.HostPairingGateway
import app.markiro.handheld.core.network.host.Observed
import app.markiro.handheld.core.network.host.PairedDto
import app.markiro.handheld.core.storage.DeviceOwner
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class HostPairingViewModelTest {
    @get:Rule
    val dispatcher = MainDispatcherRule()

    private val pin = "ab".repeat(32)
    private val otherPin = "cd".repeat(32)

    private fun hello(protocol: Int = 6, min: Int = 1) =
        HelloDto("markiro-host", protocol, min, "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f", "0.1.0", "2026-10-15T09:00:00Z", true)

    private class FakeGateway(
        val seen: Map<String, Result<Observed>>,
        var claimResult: Result<PairedDto> = Result.success(PairedDto("d1", "k1", "h1")),
    ) : HostPairingGateway {
        val observed = mutableListOf<String>()
        val claims = mutableListOf<Triple<String, String, String?>>() // address, code, recoverDeviceId
        override suspend fun observe(address: String, port: Int): Result<Observed> {
            observed += address
            return seen[address] ?: Result.failure(HostApiError(HostFailure.Unreachable))
        }

        override suspend fun claim(address: String, port: Int, pin: String, code: String, recoverDeviceId: String?): Result<PairedDto> {
            claims += Triple(address, code, recoverDeviceId)
            return claimResult
        }
    }

    private class FakeStore : HostProvisioningStore {
        val saved = mutableListOf<List<Any?>>()
        override suspend fun persist(paired: PairedDto, origin: String, pin: String, addresses: List<String>, changedPin: Boolean) {
            saved += listOf(paired.deviceId, origin, pin, addresses, changedPin)
        }
    }

    private class FakeBootstrap(var result: Result<Unit> = Result.success(Unit)) : HostBootstrap {
        var runs = 0
        override suspend fun initialSync(): Result<Unit> = result.also { runs++ }
    }

    private fun viewModel(
        gateway: FakeGateway,
        store: FakeStore = FakeStore(),
        bootstrap: FakeBootstrap = FakeBootstrap(),
        owner: DeviceOwner? = null,
    ) = dispatcher.track(HostPairingViewModel(gateway, store, bootstrap, owner))

    @Test
    fun aTypedAddressIsObservedShownAsAFingerprintAndOnlyThenClaimed() = runTest {
        val gateway = FakeGateway(mapOf("192.168.1.10" to Result.success(Observed(pin, hello()))))
        val store = FakeStore()
        val vm = viewModel(gateway, store)
        vm.onAddress("192,168,1,10")
        vm.onCode("7k3mq-9xv2d")
        vm.onContinue()
        advanceUntilIdle()
        val verify = vm.state.value as HostPairingUi.Verify
        assertEquals("ABAB ABAB ABAB ABAB ABAB ABAB ABAB ABAB", verify.display)
        assertTrue("nothing is claimed before the person compares the fingerprint", gateway.claims.isEmpty())
        vm.onFingerprintConfirmed()
        advanceUntilIdle()
        assertEquals(listOf(Triple("192.168.1.10", "7K3MQ9XV2D", null)), gateway.claims)
        assertEquals(listOf(listOf("d1", "https://192.168.1.10:45710", pin, listOf("192.168.1.10"), false)), store.saved)
        assertTrue(vm.state.value is HostPairingUi.Success)
    }

    @Test
    fun aBadAddressOrCodeIsRefusedOnTheDeviceWithoutAnyNetwork() = runTest {
        val gateway = FakeGateway(emptyMap())
        val vm = viewModel(gateway)
        vm.onAddress("10.0.0.256")
        vm.onCode("7K3MQ9XV2D")
        vm.onContinue()
        advanceUntilIdle()
        assertEquals(HostPairingError.ADDRESS_INVALID, (vm.state.value as HostPairingUi.Enter).error)
        vm.onAddress("10.0.0.5")
        vm.onCode("7K3MQ9XV2U")
        vm.onContinue()
        advanceUntilIdle()
        assertEquals(HostPairingError.CODE_INVALID, (vm.state.value as HostPairingUi.Enter).error)
        assertEquals(emptyList<String>(), gateway.observed)
    }

    @Test
    fun aHostOfAnotherProtocolIsNamedBeforeAnythingElse() = runTest {
        for ((protocol, error) in listOf(5 to HostPairingError.HOST_TOO_OLD, 9 to HostPairingError.APP_TOO_OLD)) {
            val min = if (protocol == 9) 8 else 1
            val gateway = FakeGateway(mapOf("10.0.0.5" to Result.success(Observed(pin, hello(protocol, min)))))
            val vm = viewModel(gateway)
            vm.onAddress("10.0.0.5")
            vm.onCode("7K3MQ9XV2D")
            vm.onContinue()
            advanceUntilIdle()
            assertEquals(error, (vm.state.value as HostPairingUi.Failed).error)
            assertTrue(gateway.claims.isEmpty())
        }
    }

    @Test
    fun aScannedPayloadClaimsOnlyAtTheAddressWhoseCertificateIsTheOneItNames() = runTest {
        val gateway = FakeGateway(
            mapOf(
                "10.0.0.5" to Result.success(Observed(otherPin, hello())), // some other host on the first address
                "192.168.1.10" to Result.success(Observed(pin, hello())),
            ),
        )
        val store = FakeStore()
        val vm = viewModel(gateway, store)
        vm.onScan("markiro-host:1?h=10.0.0.5,192.168.1.10&p=45710&f=$pin&c=7K3MQ9XV2D")
        advanceUntilIdle()
        assertEquals(listOf(Triple("192.168.1.10", "7K3MQ9XV2D", null)), gateway.claims)
        assertEquals(listOf("10.0.0.5", "192.168.1.10").sorted(), gateway.observed.sorted())
        assertEquals(listOf("192.168.1.10"), (store.saved.single()[3] as List<*>).take(1))
        assertTrue(vm.state.value is HostPairingUi.Success)
    }

    @Test
    fun aScannedPayloadWhoseFingerprintMatchesNoAddressSendsNoCode() = runTest {
        val gateway = FakeGateway(mapOf("10.0.0.5" to Result.success(Observed(otherPin, hello()))))
        val vm = viewModel(gateway)
        vm.onScan("markiro-host:1?h=10.0.0.5&p=45710&f=$pin&c=7K3MQ9XV2D")
        advanceUntilIdle()
        assertEquals(HostPairingError.NO_ADDRESS_MATCHES, (vm.state.value as HostPairingUi.Failed).error)
        assertTrue(gateway.claims.isEmpty())
    }

    @Test
    fun theHostsRefusalsAreShownAndNotRepeatedByThemselves() = runTest {
        val cases = mapOf(
            HostFailure.PairingInvalid to HostPairingError.PAIRING_INVALID,
            HostFailure.PairingExpired to HostPairingError.PAIRING_EXPIRED,
            HostFailure.RateLimited to HostPairingError.RATE_LIMITED,
            HostFailure.SeatLimit to HostPairingError.SEAT_LIMIT,
            HostFailure.FeatureDisabled to HostPairingError.FEATURE_DISABLED,
        )
        for ((failure, error) in cases) {
            val gateway = FakeGateway(mapOf("10.0.0.5" to Result.success(Observed(pin, hello()))), Result.failure(HostApiError(failure)))
            val vm = viewModel(gateway)
            vm.onAddress("10.0.0.5")
            vm.onCode("7K3MQ9XV2D")
            vm.onContinue()
            advanceUntilIdle()
            vm.onFingerprintConfirmed()
            advanceUntilIdle()
            assertEquals(error, (vm.state.value as HostPairingUi.Failed).error)
            assertEquals(1, gateway.claims.size)
            vm.onRetry()
            assertTrue("retry goes back to the form, it does not claim again", vm.state.value is HostPairingUi.Enter)
            assertEquals(1, gateway.claims.size)
        }
    }

    @Test
    fun aDeviceThatWasPairedClaimsAgainWithItsOwnIdAndAChangedCertificateNeedsTheNewFingerprintConfirmed() = runTest {
        val owner = DeviceOwner("https://192.168.1.10:45710", "h1", "d1", "handheld", pin)
        val gateway = FakeGateway(mapOf("192.168.1.10" to Result.success(Observed(otherPin, hello()))))
        val store = FakeStore()
        val vm = viewModel(gateway, store, owner = owner)
        vm.onCode("7K3MQ9XV2D")
        vm.onContinue()
        advanceUntilIdle()
        val verify = vm.state.value as HostPairingUi.Verify
        assertTrue("the certificate is not the paired one", verify.changed)
        assertTrue(gateway.claims.isEmpty())
        vm.onFingerprintConfirmed()
        advanceUntilIdle()
        assertEquals(listOf(Triple("192.168.1.10", "7K3MQ9XV2D", "d1")), gateway.claims)
        assertEquals(true, store.saved.single()[4])
        assertEquals(otherPin, store.saved.single()[2])
    }

    @Test
    fun aDeviceThatWasPairedAndSeesTheSameCertificateClaimsAtOnce() = runTest {
        val owner = DeviceOwner("https://192.168.1.10:45710", "h1", "d1", "handheld", pin)
        val gateway = FakeGateway(mapOf("192.168.1.10" to Result.success(Observed(pin, hello()))))
        val vm = viewModel(gateway, owner = owner)
        vm.onCode("7K3MQ9XV2D")
        vm.onContinue()
        advanceUntilIdle()
        assertEquals(listOf(Triple("192.168.1.10", "7K3MQ9XV2D", "d1")), gateway.claims)
        assertTrue(vm.state.value is HostPairingUi.Success)
    }

    @Test
    fun theFirstSyncMustLandBeforeThePairingIsDoneAndItsFailureDoesNotClaimAgain() = runTest {
        val gateway = FakeGateway(mapOf("10.0.0.5" to Result.success(Observed(pin, hello()))))
        val bootstrap = FakeBootstrap(Result.failure(HostApiError(HostFailure.Unreachable)))
        val vm = viewModel(gateway, bootstrap = bootstrap)
        vm.onAddress("10.0.0.5")
        vm.onCode("7K3MQ9XV2D")
        vm.onContinue()
        advanceUntilIdle()
        vm.onFingerprintConfirmed()
        advanceUntilIdle()
        assertEquals(HostPairingError.SYNC_FAILED, (vm.state.value as HostPairingUi.Failed).error)
        bootstrap.result = Result.success(Unit)
        vm.onRetrySync()
        advanceUntilIdle()
        assertTrue(vm.state.value is HostPairingUi.Success)
        assertEquals(1, gateway.claims.size)
        assertEquals(2, bootstrap.runs)
    }
}
