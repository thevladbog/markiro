package app.markiro.handheld.feature.signin

import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object SignInModule {
    @Provides
    @Singleton
    fun session(): SessionHolder = SessionHolder()
}
