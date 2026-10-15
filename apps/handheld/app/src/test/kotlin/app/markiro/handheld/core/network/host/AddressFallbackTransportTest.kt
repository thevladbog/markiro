package app.markiro.handheld.core.network.host

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test
import java.util.concurrent.atomic.AtomicReference

class AddressFallbackTransportTest {
    /** One scripted result per origin; keeps who was asked, in order. */
    private class Hosts(val results: Map<String, HostResult>) {
        val asked = mutableListOf<String>()
        fun transport(origin: String) = object : HostTransport {
            override suspend fun get(path: String): HostResult = answer(origin)
            override suspend fun post(path: String, body: String): HostResult = answer(origin)
        }

        private fun answer(origin: String): HostResult {
            asked += origin
            return results.getValue(origin)
        }
    }

    private val a = "https://192.168.1.5:45710"
    private val b = "https://10.0.0.5:45710"
    private val down = HostResult.Failed(TransportFailure.UNREACHABLE)
    private val ok = HostResult.Ok(200, "{}", null)
    private val wrongCert = HostResult.Failed(TransportFailure.CERT_MISMATCH)

    @Test
    fun theOtherAddressAnswersWhenThePairedOneDoesNotAndIsAskedFirstNextTime() = runTest {
        val hosts = Hosts(mapOf(a to down, b to ok))
        val active = AtomicReference<String?>(null)
        val transport = AddressFallbackTransport(listOf(a, b), hosts::transport, active)
        assertEquals(ok, transport.get("/v1/hello"))
        assertEquals(listOf(a, b), hosts.asked)
        hosts.asked.clear()
        assertEquals(ok, transport.post("/v1/device/facts", "{}"))
        assertEquals("the address that answered goes first", listOf(b), hosts.asked)
    }

    @Test
    fun anAddressWithAnotherCertificateIsNeverTrustedAndTheNextOneIsAsked() = runTest {
        val hosts = Hosts(mapOf(a to wrongCert, b to ok))
        val transport = AddressFallbackTransport(listOf(a, b), hosts::transport, AtomicReference(null))
        assertEquals(ok, transport.get("/v1/hello"))
        assertEquals(listOf(a, b), hosts.asked)
    }

    @Test
    fun whenNoAddressAnswersTheFailureIsThePairedAddresses() = runTest {
        val hosts = Hosts(mapOf(a to wrongCert, b to down))
        val transport = AddressFallbackTransport(listOf(a, b), hosts::transport, AtomicReference(b))
        assertEquals(wrongCert, transport.get("/v1/hello"))
        assertEquals("the remembered address first, then the rest", listOf(b, a), hosts.asked)
    }

    @Test
    fun aHostThatAnswersWithAnErrorHasAnsweredAndNothingElseIsAsked() = runTest {
        val refused = HostResult.Ok(503, "{}", 30)
        val hosts = Hosts(mapOf(a to refused, b to ok))
        val transport = AddressFallbackTransport(listOf(a, b), hosts::transport, AtomicReference(null))
        assertEquals(refused, transport.get("/v1/hello"))
        assertEquals(listOf(a), hosts.asked)
    }

    @Test
    fun aRememberedAddressThatIsNoLongerListedIsIgnored() = runTest {
        val hosts = Hosts(mapOf(a to ok))
        val transport = AddressFallbackTransport(listOf(a), hosts::transport, AtomicReference("https://gone:1"))
        assertEquals(ok, transport.get("/v1/hello"))
        assertEquals(listOf(a), hosts.asked)
    }
}
