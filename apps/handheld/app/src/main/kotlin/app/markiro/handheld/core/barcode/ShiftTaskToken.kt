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

    private val UUID = Regex(
        "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    )

    /** The shift id this scan carries, or null when the scan is not a shift form. */
    fun parse(raw: String): String? {
        if (!raw.startsWith(PREFIX)) return null
        val id = raw.substring(PREFIX.length).lowercase()
        return if (UUID.matches(id)) id else null
    }
}
