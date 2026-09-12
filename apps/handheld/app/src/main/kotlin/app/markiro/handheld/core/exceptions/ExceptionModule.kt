package app.markiro.handheld.core.exceptions

import app.markiro.handheld.core.storage.HandheldDatabase
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object ExceptionModule {
    @Provides
    @Singleton
    fun exceptionEngine(db: HandheldDatabase): ExceptionEngine = ExceptionEngine(db)
}
