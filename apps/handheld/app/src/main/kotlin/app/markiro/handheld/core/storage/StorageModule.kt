package app.markiro.handheld.core.storage

import android.content.Context
import androidx.room.Room
import app.markiro.handheld.core.auth.OperatorAuth
import app.markiro.handheld.core.auth.OperatorRoster
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object StorageModule {
    @Provides
    @Singleton
    fun database(@ApplicationContext context: Context): HandheldDatabase =
        Room.databaseBuilder(context, HandheldDatabase::class.java, "handheld.db").build()

    @Provides
    fun deviceConfigDao(db: HandheldDatabase): DeviceConfigDao = db.deviceConfigDao()

    @Provides
    fun operatorDao(db: HandheldDatabase): OperatorDao = db.operatorDao()

    @Provides
    @Singleton
    fun credentialStore(@ApplicationContext context: Context): CredentialStore = EncryptedCredentialStore(context)

    @Provides
    @Singleton
    fun rosterStore(dao: OperatorDao): RosterStore = RosterStore(dao)

    @Provides
    fun roster(store: RosterStore): OperatorRoster = store

    @Provides
    fun operatorAuth(roster: OperatorRoster): OperatorAuth = OperatorAuth(roster)

    @Provides
    fun deviceWipe(config: DeviceConfigDao, operators: OperatorDao, credential: CredentialStore): DeviceWipe =
        DeviceWipe(config, operators, credential)
}
