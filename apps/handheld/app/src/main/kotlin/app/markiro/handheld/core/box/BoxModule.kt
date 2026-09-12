package app.markiro.handheld.core.box

import app.markiro.handheld.core.label.LabelRenderer
import app.markiro.handheld.core.print.PrinterTransport
import app.markiro.handheld.core.storage.HandheldDatabase
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object BoxModule {
    /**
     * A singleton because the pool's lock is only worth anything if every
     * caller shares one instance.
     */
    @Provides
    @Singleton
    fun ssccPool(db: HandheldDatabase): SsccPool = SsccPool(db)

    /** A singleton for the same reason: one lock guarding one open box per shift. */
    @Provides
    @Singleton
    fun boxRepository(db: HandheldDatabase): BoxRepository = BoxRepository(db)

    /**
     * A singleton because opening a pallet, joining a box to it and closing it
     * are only serialised -- and only have an order between them -- if every
     * caller shares one lock (06d). See `PalletLock` for the ordering rule it
     * enforces.
     */
    @Provides
    @Singleton
    fun palletLock(db: HandheldDatabase): PalletLock = PalletLock(db)

    @Provides
    @Singleton
    fun palletRepository(db: HandheldDatabase, lock: PalletLock): PalletRepository = PalletRepository(db, lock)

    @Provides
    @Singleton
    fun closePallet(db: HandheldDatabase, pool: SsccPool, lock: PalletLock): ClosePallet = ClosePallet(db, pool, lock)

    @Provides
    fun closeBox(
        db: HandheldDatabase,
        boxes: BoxRepository,
        pool: SsccPool,
        pallets: PalletRepository,
        closePallet: ClosePallet,
        palletLock: PalletLock,
    ): CloseBox = CloseBox(db, boxes, pool, pallets, closePallet, palletLock)

    @Provides
    fun boxPrinter(
        db: HandheldDatabase,
        boxes: BoxRepository,
        renderer: LabelRenderer,
        transport: PrinterTransport,
    ): BoxPrinter = BoxPrinter(db, boxes, renderer, transport)

    @Provides
    fun palletPrinter(
        db: HandheldDatabase,
        pallets: PalletRepository,
        renderer: LabelRenderer,
        transport: PrinterTransport,
    ): PalletPrinter = PalletPrinter(db, pallets, renderer, transport)
}
