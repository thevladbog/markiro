package app.markiro.handheld.core.signal

import android.content.Context
import app.markiro.handheld.feature.settings.AppPreferences
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object SignalModule {
    @Provides
    @Singleton
    fun signaller(@ApplicationContext context: Context, prefs: AppPreferences): Signaller =
        Signaller(prefs, AudioTrackTonePlayer(), SystemVibration(context))
}
