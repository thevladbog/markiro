package app.markiro.handheld.core.update

import android.content.Context
import app.markiro.handheld.core.network.Bare
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object UpdateModule {
    /**
     * The bare client on purpose: the release channel is public object storage,
     * not the tenant's server. It must not carry the device credential, and it
     * must not be rewritten to the paired origin.
     */
    @Provides
    @Singleton
    fun updateCheck(@Bare client: OkHttpClient, json: Json): UpdateCheck = UpdateCheck(client, json)

    @Provides
    @Singleton
    fun updateInstaller(@ApplicationContext context: Context, @Bare client: OkHttpClient): UpdateInstaller =
        UpdateInstaller(context, client)
}
