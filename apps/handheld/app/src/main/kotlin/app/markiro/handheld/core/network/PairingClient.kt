package app.markiro.handheld.core.network

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException

enum class PairingError { INVALID, EXPIRED, LOCKED, RATE_LIMITED, KIND_MISMATCH, UNAVAILABLE, INVALID_RESPONSE, RECOVERY_MISMATCH, UPDATE_REQUIRED, OWNER_UNRESOLVED, PUBLICATION_FAILED }

sealed interface PairingResult {
    data class Success(val response: PairResponse) : PairingResult
    data class Failure(val error: PairingError) : PairingResult
}

/** The one unauthenticated request an unpaired device makes. The response carries the key: never log it. */
class PairingClient(private val client: OkHttpClient, private val json: Json) : PairingGateway {
    override suspend fun redeem(serverUrl: String, code: String): PairingResult = withContext(Dispatchers.IO) {
        if (!CODE.matches(code)) return@withContext PairingResult.Failure(PairingError.INVALID)
        val body = json.encodeToString(PairRequest.serializer(), PairRequest(code))
        val request = Request.Builder()
            .url("${serverUrl.trimEnd('/')}/station/pair")
            .header("x-station-capabilities", HANDHELD_CAPABILITIES)
            .post(body.toRequestBody("application/json".toMediaType()))
            .build()
        try {
            client.newCall(request).execute().use { response ->
                val text = response.body?.string().orEmpty()
                if (!response.isSuccessful) {
                    PairingResult.Failure(errorFrom(text))
                } else {
                    runCatching { json.decodeFromString(PairResponse.serializer(), text) }.fold(
                        onSuccess = { PairingResult.Success(it) },
                        onFailure = { PairingResult.Failure(PairingError.INVALID_RESPONSE) },
                    )
                }
            }
        } catch (_: IOException) {
            PairingResult.Failure(PairingError.UNAVAILABLE)
        }
    }

    override suspend fun recover(serverUrl: String, code: String, expected: RecoveryIdentity): PairingResult = withContext(Dispatchers.IO) {
        if (!CODE.matches(code)) return@withContext PairingResult.Failure(PairingError.INVALID)
        val body = RecoveryResponse.json.encodeToString(RecoveryRequest.serializer(), RecoveryRequest(version = 1, code = code, expected = expected))
        val request = Request.Builder().url("${serverUrl.trimEnd('/')}/station/pair/recovery")
            .header("x-station-capabilities", HANDHELD_CAPABILITIES)
            .post(body.toRequestBody("application/json".toMediaType())).build()
        try {
            client.newCall(request).execute().use { response ->
                val text = response.body?.string().orEmpty()
                if (response.code == 404 || response.code == 405) return@withContext PairingResult.Failure(PairingError.UPDATE_REQUIRED)
                if (!response.isSuccessful) return@withContext PairingResult.Failure(errorFrom(text))
                val decoded = runCatching { RecoveryResponse.decode(text) }.getOrNull()
                    ?: return@withContext PairingResult.Failure(PairingError.INVALID_RESPONSE)
                if (decoded.device.tenantId != expected.tenantId || decoded.device.id != expected.deviceId || decoded.device.kind != expected.kind) {
                    PairingResult.Failure(PairingError.RECOVERY_MISMATCH)
                } else PairingResult.Success(decoded.pairing())
            }
        } catch (_: IOException) { PairingResult.Failure(PairingError.UNAVAILABLE) }
    }

    private fun errorFrom(body: String): PairingError =
        when (runCatching { json.decodeFromString(ErrorBody.serializer(), body).code }.getOrNull()) {
            "PAIR_EXPIRED" -> PairingError.EXPIRED
            "PAIR_LOCKED" -> PairingError.LOCKED
            "PAIR_RATE_LIMITED" -> PairingError.RATE_LIMITED
            "PAIR_RECOVERY_MISMATCH" -> PairingError.RECOVERY_MISMATCH
            "PAIR_KIND_MISMATCH" -> PairingError.KIND_MISMATCH
            else -> PairingError.INVALID
        }

    private companion object {
        val CODE = Regex("^\\d{8}$")
    }
}
