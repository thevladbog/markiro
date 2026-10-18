package app.markiro.handheld.core.network.host

import app.markiro.handheld.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import javax.inject.Inject

/** A host seen through the observing client: the certificate it presented and what it said in `hello`. Untrusted until the person confirms the fingerprint. */
data class Observed(val fingerprint: String, val hello: HelloDto)

interface HostPairingGateway {
    suspend fun observe(address: String, port: Int): Result<Observed>

    /** The `claim` through a client that trusts exactly `pin`: the code goes only to the host that presents it. */
    suspend fun claim(address: String, port: Int, pin: String, code: String, recoverDeviceId: String?): Result<PairedDto>
}

class RealHostPairingGateway @Inject constructor() : HostPairingGateway {
    override suspend fun observe(address: String, port: Int): Result<Observed> = withContext(Dispatchers.IO) {
        val observer = ObservingTrustManager()
        runCatching { HostApi.observeHello(HostHttpClient.observing(observer), address, port) }
            .mapCatching { hello -> Observed(checkNotNull(observer.observed) { "no certificate was presented" }, hello) }
            .recoverCatching { throw HostApiError(HostFailure.Unreachable) }
    }

    override suspend fun claim(address: String, port: Int, pin: String, code: String, recoverDeviceId: String?): Result<PairedDto> {
        val transport = OkHttpHostTransport(HostHttpClient.pinned(pin) { null }, { "https://$address:$port" })
        return HostApi(transport).claim(code, name = DEVICE_NAME, appVersion = BuildConfig.VERSION_NAME, recoverDeviceId = recoverDeviceId)
    }

    private companion object {
        const val DEVICE_NAME = "ТСД"
    }
}
