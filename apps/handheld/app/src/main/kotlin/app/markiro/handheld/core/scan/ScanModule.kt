package app.markiro.handheld.core.scan

import android.content.Context
import app.markiro.handheld.core.storage.HandheldDatabase
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object ScanModule {
    @Provides
    @Singleton
    fun preferences(@ApplicationContext context: Context): ScanPreferences = ScanPreferences(context)

    @Provides
    @Singleton
    fun router(@ApplicationContext context: Context, preferences: ScanPreferences): ScanRouter =
        ScanRouter(context, preferences).also { it.configure() }

    @Provides
    fun scanEvents(router: ScanRouter): ScanEvents = router

    @Provides
    @Singleton
    fun scanRecorder(db: HandheldDatabase): ScanRecorder = ScanRecorder(db)
}
