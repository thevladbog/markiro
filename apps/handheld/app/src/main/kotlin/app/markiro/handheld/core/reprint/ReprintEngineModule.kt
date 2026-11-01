package app.markiro.handheld.core.reprint

import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent

@Module
@InstallIn(SingletonComponent::class)
abstract class ReprintEngineModule {
    @Binds abstract fun operations(engine: SiteReprintEngine): SiteReprintOperations
}
