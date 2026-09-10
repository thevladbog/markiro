package app.markiro.handheld.core.label

/**
 * The label the printer settings screen prints. Compiled in rather than fetched: the label-template
 * module is cabinet-only by design and a device credential cannot read it, and a handheld with no
 * shift joined has no template of its own.
 *
 * It deliberately carries the pair that can actually go wrong: a Cyrillic line, which takes the
 * image branch and exercises the platform's font engine, and an SSCC barcode, which stays a native
 * printer command. If both come out clean, the whole path works.
 */
object TestLabel {
    /** An eighteen-digit code that belongs to no real box; it exists to give the barcode a payload. */
    const val SAMPLE_SSCC = "046800899000000000"

    fun spec(): LabelSpec = LabelSpec(
        widthMm = 58.0,
        heightMm = 40.0,
        dpi = 203,
        language = PrinterLanguage.ZPL,
        elements = listOf(
            LabelElement.Box("frame", 1.0, 1.0, 56.0, 38.0, 0.25),
            LabelElement.Text("title", 4.0, 4.0, "Маркиро · тест печати", 10.0, bold = true),
            LabelElement.Text(
                "cyrillic", 4.0, 11.0,
                "Кириллица: Вода 0,5 л ПЭТ · Родник",
                8.0, maxWidthMm = 50.0, maxLines = 2,
            ),
            LabelElement.Line("rule", 4.0, 21.0, 54.0, 21.0, 0.25),
            LabelElement.Barcode(
                "bc", 6.0, 24.0, BarcodeFormat.CODE128, BarcodeSource.Field(LabelField.SSCC),
                sizeMm = 9.0, moduleWidthMm = 0.25,
            ),
            LabelElement.Field("hri", 4.0, 34.0, LabelField.SSCC, fontSizePt = 8.0, maxWidthMm = 50.0, align = LabelAlign.CENTER),
        ),
    )

    fun data(): Map<LabelField, String> = mapOf(LabelField.SSCC to SAMPLE_SSCC)
}
