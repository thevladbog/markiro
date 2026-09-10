package app.markiro.handheld.core.sync

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException

sealed interface TransportResult {
    data class Ok(val code: Int, val body: String) : TransportResult
    data class Failure(val cause: Throwable) : TransportResult
}

/** Raw JSON in, raw JSON out: the engine controls the exact bytes so a retry is byte-identical. */
class SyncTransport(private val client: OkHttpClient, private val baseUrl: () -> String) {
    private val jsonType = "application/json; charset=utf-8".toMediaType()

    suspend fun post(path: String, body: String): TransportResult = withContext(Dispatchers.IO) {
        try {
            val request = Request.Builder().url(baseUrl().trimEnd('/') + path).post(body.toRequestBody(jsonType)).build()
            client.newCall(request).execute().use { response ->
                TransportResult.Ok(response.code, response.body?.string().orEmpty())
            }
        } catch (e: IOException) {
            TransportResult.Failure(e)
        }
    }

    suspend fun get(path: String): TransportResult = withContext(Dispatchers.IO) {
        try {
            val request = Request.Builder().url(baseUrl().trimEnd('/') + path).get().build()
            client.newCall(request).execute().use { response ->
                TransportResult.Ok(response.code, response.body?.string().orEmpty())
            }
        } catch (e: IOException) {
            TransportResult.Failure(e)
        }
    }
}
