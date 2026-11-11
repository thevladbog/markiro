package app.markiro.handheld.core.label

import javax.inject.Inject
import javax.inject.Singleton

private const val TSPL_COMMAND_TERMINATOR = "\r\n"

/**
 * The single call the rest of the app makes to turn a template into printer bytes. The printer's
 * language and resolution win over the template's own, which is what lets one template serve a belt
 * printer and a line printer at once.
 */
@Singleton
open class LabelRenderer @Inject constructor(private val rasterize: RasterizeText, private val branding: OrganizationPrintBranding? = null) {
    /** Open so a test can watch the field map a caller composed; the body is the only implementation. */
    open suspend fun render(
        spec: LabelSpec,
        data: Map<LabelField, String>,
        language: PrinterLanguage,
        dpi: Int,
    ): ByteArray {
        // Rendering never fetches branding from the network.
        val logo = if (spec.elements.any { it is LabelElement.OrganizationLogo }) branding?.loadCached() else null
        return renderWithLogo(spec, data, language, dpi, logo)
    }

    /** The TSPL test prints its artwork on the media already calibrated in the printer. */
    suspend fun renderPrinterTest(language: PrinterLanguage, dpi: Int): ByteArray {
        val spec = TestLabel.spec()
        val data = TestLabel.data()
        return when (language) {
            PrinterLanguage.ZPL -> render(spec, data, language, dpi)
            PrinterLanguage.TSPL -> generateTspl(
                withPrinterDpi(spec, dpi), data, rasterize,
                commandTerminator = TSPL_COMMAND_TERMINATOR,
                configureMedia = false,
            )
        }
    }

    /** A historical pallet source carries its own immutable branding rather than today's logo. */
    open suspend fun renderWithLogo(
        spec: LabelSpec,
        data: Map<LabelField, String>,
        language: PrinterLanguage,
        dpi: Int,
        logo: RasterResult?,
    ): ByteArray {
        val printSpec = withPrinterDpi(spec, dpi)
        return when (language) {
            PrinterLanguage.ZPL -> generateZpl(printSpec, data, rasterize, logo).toByteArray(Charsets.ISO_8859_1)
            PrinterLanguage.TSPL -> generateTspl(
                printSpec, data, rasterize, logo, commandTerminator = TSPL_COMMAND_TERMINATOR,
            )
        }
    }
}
