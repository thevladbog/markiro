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

    /** A singleton for the same reason as `boxRepository`: one lock guarding one open pallet per shift (06d). */
    @Provides
    @Singleton
    fun palletRepository(db: HandheldDatabase): PalletRepository = PalletRepository(db)

    /**
     * A singleton because the mutex serialising the automatic close at
     * capacity against «Закрыть паллету досрочно» is only worth anything if
     * every caller shares one instance -- same reasoning as `CloseBox` below.
     */
    @Provides
    @Singleton
    fun closePallet(db: HandheldDatabase, pool: SsccPool): ClosePallet = ClosePallet(db, pool)

    @Provides
    fun closeBox(
        db: HandheldDatabase,
        boxes: BoxRepository,
        pool: SsccPool,
        pallets: PalletRepository,
        closePallet: ClosePallet,
    ): CloseBox = CloseBox(db, boxes, pool, pallets, closePallet)

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
