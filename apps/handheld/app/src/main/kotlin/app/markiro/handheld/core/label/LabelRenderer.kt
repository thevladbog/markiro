package app.markiro.handheld.core.label

import javax.inject.Inject
import javax.inject.Singleton

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
        val printSpec = withPrinterDpi(spec, dpi)
        // Cache failures produce null inside loadCached; recovery/owner rejection still propagates.
        val logo = if (spec.elements.any { it is LabelElement.OrganizationLogo }) branding?.loadCached() else null
        return when (language) {
            PrinterLanguage.ZPL -> generateZpl(printSpec, data, rasterize, logo).toByteArray(Charsets.ISO_8859_1)
            PrinterLanguage.TSPL -> generateTspl(printSpec, data, rasterize, logo)
        }
    }
}
