package app.markiro.handheld.core.backend

import app.markiro.handheld.core.storage.DeviceConfigDao
import kotlinx.coroutines.runBlocking
import okhttp3.Interceptor
import okhttp3.Response
import java.io.IOException

/**
 * The first interceptor of the cloud client: a device paired with a host never talks to the cloud, so a cloud call that is still wired
 * somewhere fails here, before the connection, instead of reaching a host with a cloud key header or the internet with a host's origin.
 */
class BackendGuardInterceptor(private val config: DeviceConfigDao) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        if (runBlocking { config.get()?.backend } == "host") throw IOException("a device of a host does not call the cloud")
        return chain.proceed(chain.request())
    }
}
