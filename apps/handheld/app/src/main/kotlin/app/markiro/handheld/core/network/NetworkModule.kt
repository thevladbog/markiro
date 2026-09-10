package app.markiro.handheld.core.network

import app.markiro.handheld.BuildConfig
import app.markiro.handheld.core.storage.CredentialStore
import app.markiro.handheld.core.storage.DeviceConfigDao
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import java.util.concurrent.TimeUnit
import javax.inject.Qualifier
import javax.inject.Singleton

@Qualifier
@Retention(AnnotationRetention.BINARY)
annotation class Bare

@Module
@InstallIn(SingletonComponent::class)
object NetworkModule {
    @Provides
    @Singleton
    fun json(): Json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
    }

    @Provides
    @Singleton
    fun revocationBus(): RevocationBus = RevocationBus()

    @Provides
    @Singleton
    fun reachability(): ReachabilityTracker = ReachabilityTracker()

    @Provides
    @Singleton
    fun serverUrl(config: DeviceConfigDao): ServerUrlProvider = ServerUrlProvider(config, BuildConfig.SAAS_SERVER_URL)

    /** Bare client for pairing: no key, no base-URL rewrite. Same 30 s deadline as the station. */
    @Provides
    @Singleton
    @Bare
    fun bareClient(): OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    @Provides
    @Singleton
    fun client(
        credential: CredentialStore,
        revocation: RevocationBus,
        reachability: ReachabilityTracker,
        serverUrl: ServerUrlProvider,
        json: Json,
    ): OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .addInterceptor(BaseUrlInterceptor(serverUrl))
        .addInterceptor(ApiKeyInterceptor(credential))
        .addInterceptor(CapabilitiesInterceptor())
        .addInterceptor(RevocationInterceptor(revocation, json))
        .addInterceptor(ReachabilityInterceptor(reachability))
        .build()

    @Provides
    @Singleton
    fun stationApi(client: OkHttpClient, json: Json): StationApi = Retrofit.Builder()
        .baseUrl("http://placeholder.invalid/")
        .client(client)
        .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
        .build()
        .create(StationApi::class.java)

    @Provides
    @Singleton
    fun pairingClient(@Bare client: OkHttpClient, json: Json): PairingClient = PairingClient(client, json)

    @Provides
    fun pairingGateway(client: PairingClient): PairingGateway = client
}
