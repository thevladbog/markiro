package app.markiro.handheld.core.host

import app.markiro.handheld.core.network.host.HostApiError
import app.markiro.handheld.core.network.host.HostFailure
import app.markiro.handheld.core.storage.DeviceOwner
import app.markiro.handheld.core.storage.GenerationToken
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class HostCallsTest {
    private fun token(generation: Long) = GenerationToken(DeviceOwner("https://10.0.0.5:45710", "h", "d", "handheld", "pin"), generation)

    @Test
    fun aRefusalOfTheKeyRevokesTheGenerationTheCallStartedUnderNotTheCurrentOne() = runTest {
        var current = token(1)
        val revoked = mutableListOf<GenerationToken?>()
        val calls = HostCalls({ current }) { revoked += it }
        val error = runCatching {
            calls.run<Unit> {
                current = token(2) // the device was paired again while this request was in flight
                Result.failure(HostApiError(HostFailure.KeyRejected))
            }
        }.exceptionOrNull()
        assertTrue(error is java.io.IOException)
        assertEquals(listOf<GenerationToken?>(token(1)), revoked)
    }

    @Test
    fun aDeviceWithoutAGenerationRevokesNothingOfTheCurrentOne() = runTest {
        val revoked = mutableListOf<GenerationToken?>()
        runCatching { HostCalls({ null }) { revoked += it }.run<Unit> { Result.failure(HostApiError(HostFailure.KeyRejected)) } }
        assertEquals(listOf<GenerationToken?>(null), revoked)
    }
}
