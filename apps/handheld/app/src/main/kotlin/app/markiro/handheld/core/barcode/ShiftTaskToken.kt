package app.markiro.handheld.core.barcode

/**
 * The printed shift task form's Data Matrix payload.
 *
 * Deliberately a second implementation of the rule in `@markiro/domain`
 * (`src/barcodes/task-tokens.ts`) rather than a shared artefact: Kotlin cannot
 * import it, and a generated fixture would be heavier than the rule itself.
 * `ShiftTaskTokenTest` mirrors the TypeScript cases one for one -- change both
 * or neither.
 */
object ShiftTaskToken {
    const val PREFIX = "markiro:shift:v1:"

    // UUID pattern that matches Zod's z.uuid() rule on the TypeScript side: accepts either the nil UUID
    // (00000000-0000-0000-0000-000000000000) explicitly, or a v1–v5 UUID with the variant bits set.
    // The nil UUID is not a meaningful shift id but must be accepted for parity with TypeScript validation.
    private val UUID = Regex(
        "^(00000000-0000-0000-0000-000000000000|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$",
    )

    /** The shift id this scan carries, or null when the scan is not a shift form. */
    fun parse(raw: String): String? {
        if (!raw.startsWith(PREFIX)) return null
        val id = raw.substring(PREFIX.length).lowercase()
        return if (UUID.matches(id)) id else null
    }
}
