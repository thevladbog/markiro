package app.markiro.handheld.core.storage

import android.content.Context
import androidx.room.Room
import app.markiro.handheld.core.auth.OperatorAuth
import app.markiro.handheld.core.auth.OperatorRoster
import app.markiro.handheld.core.print.PrinterDao
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
        Room.databaseBuilder(context, HandheldDatabase::class.java, "handheld.db")
            .addMigrations(MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4, MIGRATION_4_5, MIGRATION_5_6, MIGRATION_6_7)
            .build()

    @Provides
    fun printerDao(db: HandheldDatabase): PrinterDao = db.printerDao()

    @Provides
    fun inventoryTaskDao(db: HandheldDatabase): InventoryTaskDao = db.inventoryTaskDao()

    @Provides
    fun inventorySnapshotCodeDao(db: HandheldDatabase): InventorySnapshotCodeDao = db.inventorySnapshotCodeDao()

    @Provides
    fun inventoryTerminalStateDao(db: HandheldDatabase): InventoryTerminalStateDao = db.inventoryTerminalStateDao()

    @Provides
    fun inventoryEventDao(db: HandheldDatabase): InventoryEventDao = db.inventoryEventDao()

    @Provides
    fun inventoryResultDao(db: HandheldDatabase): InventoryResultDao = db.inventoryResultDao()

    @Provides
    fun inventoryOutboxDao(db: HandheldDatabase): InventoryOutboxDao = db.inventoryOutboxDao()

    @Provides
    fun deviceConfigDao(db: HandheldDatabase): DeviceConfigDao = db.deviceConfigDao()

    @Provides
    fun operatorDao(db: HandheldDatabase): OperatorDao = db.operatorDao()

    @Provides
    fun shiftDao(db: HandheldDatabase): ShiftDao = db.shiftDao()

    @Provides
    fun codeDao(db: HandheldDatabase): CodeDao = db.codeDao()

    @Provides
    fun scanEventDao(db: HandheldDatabase): ScanEventDao = db.scanEventDao()

    @Provides
    fun outboxDao(db: HandheldDatabase): OutboxDao = db.outboxDao()

    @Provides
    fun conflictDao(db: HandheldDatabase): ConflictDao = db.conflictDao()

    @Provides
    fun shiftCloseDao(db: HandheldDatabase): ShiftCloseDao = db.shiftCloseDao()

    @Provides
    @Singleton
    fun metaStore(db: HandheldDatabase): MetaStore = MetaStore(db.metaDao())

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
    fun deviceWipe(db: HandheldDatabase, credential: CredentialStore): DeviceWipe = DeviceWipe(db, credential)
}
