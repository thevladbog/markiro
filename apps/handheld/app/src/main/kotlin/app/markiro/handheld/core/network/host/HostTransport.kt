package app.markiro.handheld.core.network.host

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.net.SocketTimeoutException
import kotlin.coroutines.resume

sealed interface HostResult {
    data class Ok(val code: Int, val body: String, val retryAfterSeconds: Long?) : HostResult
    data class Failed(val failure: TransportFailure) : HostResult
}

interface HostTransport {
    suspend fun get(path: String): HostResult
    suspend fun getCancellable(path: String): HostResult = get(path)
    suspend fun post(path: String, body: String): HostResult
}

/** OkHttp over the pinned client: the body of a POST is the caller's bytes, never re-encoded (a retry is byte-identical). */
class OkHttpHostTransport(
    private val client: Call.Factory,
    private val origin: () -> String,
    private val onResponse: () -> Unit = {},
) : HostTransport {
    private val json = "application/json; charset=utf-8".toMediaType()

    override suspend fun get(path: String): HostResult = execute(getRequest(path))

    override suspend fun getCancellable(path: String): HostResult = suspendCancellableCoroutine { continuation ->
        val call = client.newCall(getRequest(path))
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                continuation.resume(failure(e))
            }

            override fun onResponse(call: Call, response: Response) {
                val result = try {
                    readResponse(response)
                } catch (e: IOException) {
                    failure(e)
                }
                continuation.resume(result)
            }
        })
    }

    private fun getRequest(path: String): Request = Request.Builder().url(origin().trimEnd('/') + path).get().build()

    override suspend fun post(path: String, body: String): HostResult =
        execute(Request.Builder().url(origin().trimEnd('/') + path).post(body.toRequestBody(json)).build())

    private suspend fun execute(request: Request): HostResult = withContext(Dispatchers.IO) {
        try {
            readResponse(client.newCall(request).execute())
        } catch (e: IOException) {
            failure(e)
        }
    }

    private fun readResponse(response: Response): HostResult = response.use {
        onResponse()
        HostResult.Ok(it.code, it.body?.string().orEmpty(), it.header("Retry-After")?.toLongOrNull())
    }

    private fun failure(e: IOException): HostResult.Failed {
        if (e is SocketTimeoutException) return HostResult.Failed(TransportFailure.TIMEOUT)
        val mismatch = generateSequence<Throwable>(e) { it.cause }.any { it is FingerprintMismatch }
        return HostResult.Failed(if (mismatch) TransportFailure.CERT_MISMATCH else TransportFailure.UNREACHABLE)
    }
}
