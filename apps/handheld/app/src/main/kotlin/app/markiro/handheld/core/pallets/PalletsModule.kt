package app.markiro.handheld.core.pallets

import app.markiro.handheld.core.box.ClosePallet
import app.markiro.handheld.core.box.PalletLock
import app.markiro.handheld.core.box.SsccPool
import app.markiro.handheld.core.backend.StationBackend
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object PalletsModule {
    @Provides
    @Singleton
    fun boxRegistryMirror(backend: StationBackend, db: HandheldDatabase, meta: MetaStore): BoxRegistryMirror =
        BoxRegistryMirror(backend, db, meta)

    @Provides
    @Singleton
    fun ssccBlockApplier(pool: SsccPool): SsccBlockApplier = SsccBlockApplier(pool)

    @Provides
    @Singleton
    fun palletBootstrapMirror(
        backend: StationBackend,
        db: HandheldDatabase,
        meta: MetaStore,
        blocks: SsccBlockApplier,
        registry: BoxRegistryMirror,
    ): PalletBootstrapMirror = PalletBootstrapMirror(backend, db, meta, blocks, registry)

    /**
     * A singleton for the reason `PalletLock` itself is one: opening, filling
     * and closing the device's warehouse pallet are only serialised when every
     * caller shares the same lock -- and this class is where the UI reaches it.
     */
    @Provides
    @Singleton
    fun warehousePallets(db: HandheldDatabase, lock: PalletLock, closer: ClosePallet, meta: MetaStore): WarehousePallets =
        WarehousePallets(db, lock, closer, meta)
}
