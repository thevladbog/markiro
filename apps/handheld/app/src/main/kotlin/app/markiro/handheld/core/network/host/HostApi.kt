package app.markiro.handheld.core.network.host

import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import java.io.IOException

/** A detail that is a string, or `null` for anything else (an object, an array, a number, a missing key): a defect of the host must not throw. */
fun JsonObject?.text(key: String): String? = (this?.get(key) as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

/** A detail that is a JSON number read as an `Int`, or `null` for anything else (a string, an object, a missing key). */
fun JsonObject?.int(key: String): Int? = (this?.get(key) as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull

/** A detail that is the JSON boolean `true`; a missing key, a string `"true"` or anything else is `false`. */
fun JsonObject?.flag(key: String): Boolean = (this?.get(key) as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull == true

/** The calls of the host's protocol (spec 5, 8.1). Every call answers a `Result`; a failure is a [HostApiError]. */
class HostApi(private val transport: HostTransport, private val json: Json = Json { ignoreUnknownKeys = true }) {
    private fun failureOf(result: HostResult.Ok): HostFailure {
        val error = runCatching { json.decodeFromString(ErrorEnvelopeDto.serializer(), result.body).error }.getOrNull()
            ?: return if (result.code >= 500) HostFailure.ServerError(result.code) else HostFailure.BadResponse
        val constraint = error.details.text("constraint")
        return when {
            error.code == "restore_pending" -> HostFailure.RestorePending(result.retryAfterSeconds)
            error.code == "unauthorized" && error.details.text("credential") == "device" -> HostFailure.KeyRejected
            error.code == "forbidden" -> HostFailure.Forbidden
            error.code == "pairing_code_invalid" -> HostFailure.PairingInvalid
            error.code == "pairing_code_expired" -> HostFailure.PairingExpired
            error.code == "rate_limited" -> HostFailure.RateLimited
            error.code == "protocol_unsupported" -> HostFailure.ProtocolUnsupported
            constraint == "seat_limit" -> HostFailure.SeatLimit
            constraint == "feature_disabled" -> HostFailure.FeatureDisabled
            constraint == "license_restricted" -> HostFailure.LicenseRestricted
            constraint != null -> HostFailure.Constraint(constraint, error.details.int("maxStations"), error.details.int("active"))
            result.code >= 500 -> HostFailure.ServerError(result.code)
            else -> HostFailure.BadResponse
        }
    }

    private fun errorCodeOf(result: HostResult.Ok): String? =
        runCatching { json.decodeFromString(ErrorEnvelopeDto.serializer(), result.body).error.code }.getOrNull()

    private fun <T> parse(result: HostResult, serializer: KSerializer<T>): Result<T> = when (result) {
        is HostResult.Failed -> Result.failure(
            HostApiError(
                when (result.failure) {
                    TransportFailure.UNREACHABLE -> HostFailure.Unreachable
                    TransportFailure.TIMEOUT -> HostFailure.Timeout
                    TransportFailure.CERT_MISMATCH -> HostFailure.CertificateMismatch
                },
            ),
        )
        is HostResult.Ok ->
            if (result.code in 200..299) {
                runCatching { json.decodeFromString(serializer, result.body) }
                    .fold({ Result.success(it) }, { Result.failure(HostApiError(HostFailure.BadResponse, result.code)) })
            } else {
                Result.failure(HostApiError(failureOf(result), result.code, errorCodeOf(result)))
            }
    }

    suspend fun hello(): Result<HelloDto> = parse(transport.get("/v1/hello"), HelloDto.serializer())

    suspend fun claim(code: String, name: String, appVersion: String, recoverDeviceId: String?): Result<PairedDto> {
        val body = buildJsonObject {
            put("code", code)
            put("kind", "handheld")
            put("name", name)
            put("appVersion", appVersion)
            put("capabilities", JsonArray(listOf(JsonPrimitive(CAPABILITY))))
            if (recoverDeviceId != null) put("recoverDeviceId", recoverDeviceId)
        }.toString()
        return parse(transport.post("/v1/pairing/claim", body), PairedDto.serializer())
    }

    suspend fun device(): Result<DeviceInfoDto> = parse(transport.get("/v1/device"), DeviceInfoDto.serializer())

    suspend fun changes(since: Long, limit: Int = 500): Result<ChangesDto> =
        parse(transport.get("/v1/changes?since=$since&limit=$limit"), ChangesDto.serializer())

    suspend fun shifts(): Result<DeviceShiftsDto> = parse(transport.get("/v1/device/shifts"), DeviceShiftsDto.serializer())

    suspend fun enter(shiftId: String): Result<DeviceShiftDto> {
        val body = buildJsonObject { put("supports", JsonArray(ENTER_SUPPORTS.map(::JsonPrimitive))) }.toString()
        return parse(transport.post("/v1/device/shifts/$shiftId/enter", body), DeviceShiftDto.serializer())
    }

    /**
     * Frees this device's slot of a shared shift (`POST /v1/device/shifts/{id}/leave`, protocol 7), answered with the shift as the device sees it.
     * [joinedRev] is this device's own `participants[].joinedRev` from its last entry answer, sent as `{"joinedRev":N}` (`ShiftLeave`); the host
     * ignores a token of an earlier stay (no write, `myState` stays `active`). `null` sends no body (no token known: an older host). State-idempotent
     * on the host, so a retry after a lost answer is harmless; `shift_not_entered` means the host holds no slot of this device.
     */
    suspend fun leave(shiftId: String, joinedRev: Long?): Result<DeviceShiftDto> =
        parse(
            transport.post("/v1/device/shifts/$shiftId/leave", joinedRev?.let { """{"joinedRev":$it}""" } ?: ""),
            DeviceShiftDto.serializer(),
        )

    suspend fun block(requestId: String, issuerPrefix: String, extension: Int): Result<SsccBlockDto> {
        val body = buildJsonObject {
            put("requestId", requestId)
            put("issuerPrefix", issuerPrefix)
            put("extension", extension)
        }.toString()
        return parse(transport.post("/v1/device/sscc/blocks", body), SsccBlockDto.serializer())
    }

    /**
     * Tells the host the blocks this device holds, 64 to a request (`more: true` on every request but the last). The results of all
     * the batches are returned together; the first failing batch ends the call.
     */
    suspend fun knownBlocks(blocks: List<KnownBlock>): Result<List<KnownBlockResultDto>> {
        val batches = blocks.chunked(KNOWN_BLOCKS_BATCH).ifEmpty { listOf(emptyList()) }
        val results = mutableListOf<KnownBlockResultDto>()
        for ((index, batch) in batches.withIndex()) {
            val body = buildJsonObject {
                put(
                    "blocks",
                    JsonArray(
                        batch.map {
                            buildJsonObject {
                                put("id", it.id)
                                put("issuerPrefix", it.issuerPrefix)
                                put("extension", it.extension)
                                put("fromSerial", it.fromSerial)
                                put("toSerial", it.toSerial)
                            }
                        },
                    ),
                )
                if (index < batches.lastIndex) put("more", true)
            }.toString()
            val answer = parse(transport.post("/v1/device/sscc/blocks/known", body), KnownBlocksResponseDto.serializer())
            results += answer.getOrElse { return Result.failure(it) }.results
        }
        return Result.success(results)
    }

    /** `body` is the batch as frozen by the caller (`{"records":[…]}`): sent as it is, so a retry is byte-identical. */
    suspend fun postFacts(body: String): Result<List<FactReceiptDto>> =
        parse(transport.post("/v1/device/facts", body), FactReceiptsDto.serializer()).map { it.receipts }

    suspend fun postPalletEvents(body: String): Result<List<FactReceiptDto>> =
        parse(transport.post("/v1/device/pallet-events", body), FactReceiptsDto.serializer()).map { it.receipts }

    suspend fun orgPrint(): Result<OrgPrintDto> = parse(transport.get("/v1/device/org/print"), OrgPrintDto.serializer())

    /** One page of the registry of closed boxes; `until` is null on the first page of a walk. */
    suspend fun boxRegistry(since: String?, until: String?, cursor: String?, limit: Int): Result<JsonObject> {
        val query = buildList {
            add("limit=$limit")
            since?.let { add("since=" + java.net.URLEncoder.encode(it, "UTF-8")) }
            until?.let { add("until=" + java.net.URLEncoder.encode(it, "UTF-8")) }
            cursor?.let { add("cursor=" + java.net.URLEncoder.encode(it, "UTF-8")) }
        }.joinToString("&")
        return parse(transport.get("/v1/device/box-registry?$query"), JsonObject.serializer())
    }

    companion object {
        const val CAPABILITY = "handheld-host-v1"

        /** A validation shift without duplicate printing is a plain scan flow of this app; the duplicate (`validation-dm-duplicate-v1`) is not named, so the host refuses that shift with `station_update`. */
        const val CAPABILITY_VALIDATION = "validation-v1"

        /** Several devices in one shift (protocol 7): named on every entry, so a free slot of the line takes this device; an older host ignores the name. */
        const val CAPABILITY_MULTI_STATION = "multi-station-v1"
        internal val ENTER_SUPPORTS = listOf(CAPABILITY, CAPABILITY_VALIDATION, CAPABILITY_MULTI_STATION)
        const val KNOWN_BLOCKS_BATCH = 64

        /**
         * `GET /v1/hello` through the observing client, the certificate recorded by `client`'s trust manager. The only thing a host that
         * is not yet verified is asked. Throws [IOException] when the host does not answer.
         */
        suspend fun observeHello(client: OkHttpClient, host: String, port: Int): HelloDto {
            val transport = OkHttpHostTransport(client, { "https://$host:$port" })
            return HostApi(transport).hello().getOrElse { throw IOException("the host did not answer hello", it) }
        }
    }
}
