package app.markiro.handheld.core.network

import app.markiro.handheld.core.storage.CredentialStore
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

class ApiKeyInterceptor(private val credential: CredentialStore) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val key = credential.read() ?: return chain.proceed(chain.request())
        return chain.proceed(chain.request().newBuilder().header("x-api-key", key).build())
    }
}

class CapabilitiesInterceptor : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response =
        chain.proceed(chain.request().newBuilder().header("x-station-capabilities", HANDHELD_CAPABILITIES).build())
}

/** Emits once per rejected credential; the app shell wipes and returns to pairing. */
class RevocationBus {
    private val flow = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val events: SharedFlow<Unit> = flow

    fun raise() {
        flow.tryEmit(Unit)
    }
}

class RevocationInterceptor(
    private val bus: RevocationBus,
    private val json: Json = Json { ignoreUnknownKeys = true },
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val response = chain.proceed(chain.request())
        if (response.code == 401) {
            val body = response.peekBody(2048).string()
            val code = runCatching { json.decodeFromString(ErrorBody.serializer(), body).code }.getOrNull()
            if (code == REVOKED_CODE) bus.raise()
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
        val base = provider.current().trimEnd('/').toHttpUrlOrNull() ?: return chain.proceed(chain.request())
        val rebuilt = chain.request().url.newBuilder().scheme(base.scheme).host(base.host).port(base.port).build()
        return chain.proceed(chain.request().newBuilder().url(rebuilt).build())
    }
}
