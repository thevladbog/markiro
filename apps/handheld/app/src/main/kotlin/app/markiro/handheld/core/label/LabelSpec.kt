package app.markiro.handheld.core.label

/**
 * Port of `packages/domain/src/labels/model.ts`. A spec is printer-neutral millimetre geometry;
 * the printer's language and resolution are applied at emit time, which is what lets one template
 * serve mixed printers. Every optional is nullable rather than defaulted: the TypeScript schema has
 * no `.default()` anywhere and the emitters branch on absence, so defaulting here changes output.
 */
enum class PrinterLanguage(val wire: String) {
    ZPL("zpl"),
    TSPL("tspl"),
    ;

    companion object {
        fun fromWire(value: String): PrinterLanguage =
            entries.firstOrNull { it.wire == value } ?: throw LabelRenderException("unknown printer language: $value")
    }
}

enum class LabelField(val wire: String) {
    PRODUCT_NAME("product.name"),
    PRODUCT_PRINT_NAME("product.printName"),
    PRODUCT_GTIN("product.gtin"),
    PRODUCT_EGAIS("product.egais"),
    KM_CODE("km.code"),
    SSCC("sscc"),
    SHIFT_NO("shift.no"),
    DATE("date"),
    EXPIRY("expiry"),
    QTY("qty"),
    OPERATOR("operator"),
    COUNTERPARTY_NAME("counterparty.name"),
    ;

    companion object {
        fun fromWire(value: String): LabelField =
            entries.firstOrNull { it.wire == value } ?: throw LabelRenderException("unknown label field: $value")
    }
}

enum class TextFormat(val wire: String) {
    KM_WITHOUT_CRYPTO("km_without_crypto"),
    ;

    companion object {
        fun fromWire(value: String): TextFormat =
            entries.firstOrNull { it.wire == value } ?: throw LabelRenderException("unknown text format: $value")
    }
}

enum class LabelAlign(val wire: String) {
    LEFT("left"),
    CENTER("center"),
    RIGHT("right"),
    ;

    companion object {
        fun fromWire(value: String): LabelAlign =
            entries.firstOrNull { it.wire == value } ?: throw LabelRenderException("unknown align: $value")
    }
}

enum class BarcodeFormat(val wire: String) {
    DATAMATRIX("datamatrix"),
    CODE128("code128"),
    EAN13("ean13"),
    QR("qr"),
    ;

    companion object {
        fun fromWire(value: String): BarcodeFormat =
            entries.firstOrNull { it.wire == value } ?: throw LabelRenderException("unknown barcode format: $value")
    }
}

/** A barcode's payload: a field of the label data, or a literal the template author typed. */
sealed interface BarcodeSource {
    data class Field(val field: LabelField) : BarcodeSource
    data class Literal(val value: String) : BarcodeSource
}

sealed interface LabelElement {
    val id: String
    val xMm: Double
    val yMm: Double

    data class Text(
        override val id: String,
        override val xMm: Double,
        override val yMm: Double,
        val text: String,
        val fontSizePt: Double,
        val bold: Boolean? = null,
        val align: LabelAlign? = null,
        val maxWidthMm: Double? = null,
        val maxLines: Int? = null,
    ) : LabelElement

    data class Field(
        override val id: String,
        override val xMm: Double,
        override val yMm: Double,
        val field: LabelField,
        val textFormat: TextFormat? = null,
        val fontSizePt: Double,
        val bold: Boolean? = null,
        val align: LabelAlign? = null,
        val maxWidthMm: Double? = null,
        val maxLines: Int? = null,
    ) : LabelElement

    data class Barcode(
        override val id: String,
        override val xMm: Double,
        override val yMm: Double,
        val format: BarcodeFormat,
        val data: BarcodeSource,
        /** Height for code128 and ean13; the module square side for datamatrix and qr. */
        val sizeMm: Double,
        val moduleWidthMm: Double? = null,
    ) : LabelElement

    data class Line(
        override val id: String,
        override val xMm: Double,
        override val yMm: Double,
        val x2Mm: Double,
        val y2Mm: Double,
        val thicknessMm: Double,
    ) : LabelElement

    data class Box(
        override val id: String,
        override val xMm: Double,
        override val yMm: Double,
        val widthMm: Double,
        val heightMm: Double,
        val thicknessMm: Double,
    ) : LabelElement
}

data class LabelSpec(
    val widthMm: Double,
    val heightMm: Double,
    /** 203 or 300. */
    val dpi: Int,
    val language: PrinterLanguage,
    val elements: List<LabelElement>,
)

/** Raised when a template asks for something this device cannot render. */
class LabelRenderException(message: String) : Exception(message)
