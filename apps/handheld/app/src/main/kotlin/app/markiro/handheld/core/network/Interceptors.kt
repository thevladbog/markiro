package app.markiro.handheld.core.network

import app.markiro.handheld.core.storage.DeviceRecovery
import app.markiro.handheld.core.storage.GenerationToken
import java.io.IOException
import okhttp3.Call
import okhttp3.Request
import app.markiro.handheld.core.storage.DeviceConfigDao
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.Response

/** Capture credentials when the call is created, before OkHttp can queue its execution. */
class GenerationCallFactory(private val client: Call.Factory, private val recovery: DeviceRecovery) : Call.Factory {
    override fun newCall(request: Request): Call {
        val token = DeviceRecovery.generationContext.get() ?: recovery.token()
        val key = recovery.key(token)
        if (!recovery.valid(token)) throw IOException("Credential generation changed")
        return client.newCall(request.newBuilder().tag(GenerationToken::class.java, token).header("x-api-key", key).build())
    }
}

class ApiKeyInterceptor(private val recovery: DeviceRecovery) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val token = chain.request().tag(GenerationToken::class.java)
        if (token == null || !recovery.valid(token)) throw IOException("Credential generation is sealed")
        return chain.proceed(chain.request())
    }
}

class CapabilitiesInterceptor : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response =
        chain.proceed(chain.request().newBuilder().header("x-station-capabilities", HANDHELD_CAPABILITIES).build())
}

/** Emits once per rejected credential; the app shell wipes and returns to pairing. */
class RevocationBus {
    private val flow = MutableSharedFlow<GenerationToken>(extraBufferCapacity = 16)
    val events: SharedFlow<GenerationToken> = flow

    fun raise(token: GenerationToken) {
        flow.tryEmit(token)
    }
}

class RevocationInterceptor(
    private val bus: RevocationBus,
    private val recovery: DeviceRecovery,
    private val json: Json = Json { ignoreUnknownKeys = true },
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val response = chain.proceed(chain.request())
        if (response.code == 401) {
            val body = response.peekBody(2048).string()
            val code = runCatching { json.decodeFromString(ErrorBody.serializer(), body).code }.getOrNull()
            if (code == REVOKED_CODE) chain.request().tag(GenerationToken::class.java)?.let {
                if (runBlocking { recovery.reject(it) }) bus.raise(it)
            }
        }
        return response
    }
}

/** Last time any request got an HTTP response; drives the «Сеть» indicator. */
class ReachabilityTracker(private val now: () -> Long = System::currentTimeMillis) {
    private val state = MutableStateFlow<Long?>(null)
    val lastSuccessAt: StateFlow<Long?> = state

    fun markSuccess() {
        state.value = now()
    }
}

class ReachabilityInterceptor(private val tracker: ReachabilityTracker) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val response = chain.proceed(chain.request())
        tracker.markSuccess()
        return response
    }
}

/** The paired server URL from config; the debug build may override it before pairing. */
class ServerUrlProvider(private val config: DeviceConfigDao, private val fallback: String) {
    @Volatile
    var debugOverride: String? = null

    fun current(): String = debugOverride ?: runBlocking { config.get()?.serverUrl } ?: fallback
}

/** Retrofit needs a base URL at build time; the real origin is only known after pairing. */
class BaseUrlInterceptor(private val provider: ServerUrlProvider) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val base = (chain.request().tag(GenerationToken::class.java)?.owner?.serverOrigin ?: provider.current()).trimEnd('/').toHttpUrlOrNull() ?: return chain.proceed(chain.request())
        val rebuilt = chain.request().url.newBuilder().scheme(base.scheme).host(base.host).port(base.port).build()
        return chain.proceed(chain.request().newBuilder().url(rebuilt).build())
    }
}
