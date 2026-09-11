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

    @Provides
    fun closeBox(db: HandheldDatabase, boxes: BoxRepository, pool: SsccPool): CloseBox = CloseBox(db, boxes, pool)

    @Provides
    fun boxPrinter(
        db: HandheldDatabase,
        boxes: BoxRepository,
        renderer: LabelRenderer,
        transport: PrinterTransport,
    ): BoxPrinter = BoxPrinter(db, boxes, renderer, transport)
}
