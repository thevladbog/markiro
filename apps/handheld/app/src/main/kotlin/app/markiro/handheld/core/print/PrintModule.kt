package app.markiro.handheld.core.print

import app.markiro.handheld.core.label.AndroidTextRasterizer
import app.markiro.handheld.core.label.LabelRenderer
import app.markiro.handheld.core.label.RasterizeText
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object PrintModule {
    @Provides
    @Singleton
    fun rasterizeText(rasterizer: AndroidTextRasterizer): RasterizeText = rasterizer

    @Provides
    @Singleton
    fun labelRenderer(rasterize: RasterizeText): LabelRenderer = LabelRenderer(rasterize)

    @Provides
    @Singleton
    fun printerTransport(
        wifi: WifiPrinterConnector,
        bluetooth: BluetoothPrinterConnector,
    ): PrinterTransport = StreamPrinterTransport { printer ->
        if (printer.transport == "bluetooth") bluetooth else wifi
    }
}
