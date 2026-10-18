package app.markiro.handheld.core.network.host

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.net.SocketTimeoutException

sealed interface HostResult {
    data class Ok(val code: Int, val body: String, val retryAfterSeconds: Long?) : HostResult
    data class Failed(val failure: TransportFailure) : HostResult
}

interface HostTransport {
    suspend fun get(path: String): HostResult
    suspend fun post(path: String, body: String): HostResult
}

/** OkHttp over the pinned client: the body of a POST is the caller's bytes, never re-encoded (a retry is byte-identical). */
class OkHttpHostTransport(
    private val client: Call.Factory,
    private val origin: () -> String,
    private val onResponse: () -> Unit = {},
) : HostTransport {
    private val json = "application/json; charset=utf-8".toMediaType()

    override suspend fun get(path: String): HostResult = execute(Request.Builder().url(origin().trimEnd('/') + path).get().build())

    override suspend fun post(path: String, body: String): HostResult =
        execute(Request.Builder().url(origin().trimEnd('/') + path).post(body.toRequestBody(json)).build())

    private suspend fun execute(request: Request): HostResult = withContext(Dispatchers.IO) {
        try {
            client.newCall(request).execute().use { response ->
                onResponse()
                HostResult.Ok(response.code, response.body?.string().orEmpty(), response.header("Retry-After")?.toLongOrNull())
            }
        } catch (e: SocketTimeoutException) {
            HostResult.Failed(TransportFailure.TIMEOUT)
        } catch (e: IOException) {
            val mismatch = generateSequence<Throwable>(e) { it.cause }.any { it is FingerprintMismatch }
            HostResult.Failed(if (mismatch) TransportFailure.CERT_MISMATCH else TransportFailure.UNREACHABLE)
        }
    }
}
