package app.markiro.handheld.core.network.host

/** Why a call of the host did not give its answer (spec 8.1). */
sealed interface HostFailure {
    data object Unreachable : HostFailure
    data object Timeout : HostFailure

    /** The host presents another certificate than the paired one: never accepted silently (risk Р-2). */
    data object CertificateMismatch : HostFailure
    data object KeyRejected : HostFailure
    data object Forbidden : HostFailure
    data object PairingInvalid : HostFailure
    data object PairingExpired : HostFailure
    data object RateLimited : HostFailure
    data object SeatLimit : HostFailure
    data object FeatureDisabled : HostFailure
    data object LicenseRestricted : HostFailure
    data object ProtocolUnsupported : HostFailure
    data class RestorePending(val retryAfterSeconds: Long?) : HostFailure

    /**
     * A `409 conflict` with a constraint of its own (`shift_busy`, `shift_line`, `station_update`, …). `shift_line_full` also carries
     * `maxStations` and `active`.
     */
    data class Constraint(val name: String, val maxStations: Int? = null, val active: Int? = null) : HostFailure
    data class ServerError(val status: Int) : HostFailure
    data object BadResponse : HostFailure
}

class HostApiError(val failure: HostFailure, val status: Int? = null) : Exception("host call failed: $failure")

enum class TransportFailure { UNREACHABLE, TIMEOUT, CERT_MISMATCH }
