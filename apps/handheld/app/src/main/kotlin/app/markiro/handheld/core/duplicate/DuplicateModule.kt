package app.markiro.handheld.core.duplicate

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
object DuplicateModule {
    @Provides
    @Singleton
    fun duplicateJobs(
        db: HandheldDatabase,
        renderer: LabelRenderer,
        transport: PrinterTransport,
    ): DuplicateJobs = DuplicateJobs(db, renderer, transport)
}
