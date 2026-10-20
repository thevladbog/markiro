package app.markiro.handheld.feature.signin

import app.markiro.handheld.feature.hub.RosterRefresher
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

    /** The sign-in reads the operator roster again on its own (a roster that only the hub refreshed was unreachable before the first sign-in). */
    @Provides
    fun rosterSource(refresher: RosterRefresher): RosterSource = refresher
}
