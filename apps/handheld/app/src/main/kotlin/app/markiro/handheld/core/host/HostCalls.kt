package app.markiro.handheld.core.host

import app.markiro.handheld.core.network.host.HostApiError
import app.markiro.handheld.core.network.host.HostFailure
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import retrofit2.HttpException
import retrofit2.Response
import java.io.IOException

/**
 * Where a refusal of the host becomes what the app's loaders already read from the cloud: `IOException` for «нет связи» (a shift whose bundle is
 * on the device is then entered offline), `HttpException` with the cloud's own code for a refusal they show. A rejected key revokes this device
 * once (`revocation`), as the cloud's `RevocationInterceptor` does.
 */
class HostCalls(private val revocation: suspend () -> Unit) {
    suspend fun <T> run(block: suspend () -> Result<T>): T = block().getOrElse { throw translate(it) }

    private suspend fun translate(error: Throwable): Throwable {
        val failure = (error as? HostApiError)?.failure ?: return IOException("host call failed", error)
        return when (failure) {
            HostFailure.KeyRejected -> {
                revocation()
                IOException("the host rejected this device's key")
            }
            is HostFailure.Constraint -> http(
                409,
                when (failure.name) {
                    "station_update" -> "STATION_UPDATE_REQUIRED"
                    "shift_status" -> null // the cloud's closed shift is a `409` with no code
                    else -> failure.name
                },
            )
            HostFailure.LicenseRestricted -> http(409, "license_restricted")
            HostFailure.FeatureDisabled -> http(409, "feature_disabled")
            HostFailure.SeatLimit -> http(409, "seat_limit")
            HostFailure.Forbidden -> http(403, "forbidden")
            HostFailure.ProtocolUnsupported -> http(409, "STATION_UPDATE_REQUIRED")
            HostFailure.Unreachable, HostFailure.Timeout, HostFailure.CertificateMismatch, HostFailure.BadResponse,
            is HostFailure.RestorePending, is HostFailure.ServerError,
            -> IOException("the host did not give its answer: $failure", error)
            HostFailure.PairingInvalid, HostFailure.PairingExpired, HostFailure.RateLimited -> IOException("unexpected on this call: $failure", error)
        }
    }

    private fun http(status: Int, code: String?): HttpException {
        val body = (if (code == null) "{}" else """{"code":"$code"}""").toResponseBody("application/json".toMediaType())
        return HttpException(Response.error<Any>(status, body))
    }
}
