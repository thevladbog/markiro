package app.markiro.handheld.core.barcode

/**
 * The printed shift task form's Data Matrix payload.
 *
 * Deliberately a second implementation of the rule in `@markiro/domain`
 * (`src/barcodes/task-tokens.ts`) rather than a shared artefact: Kotlin cannot
 * import it, and a generated fixture would be heavier than the rule itself.
 * The shift id rule, matched against the lowercased payload: an 8-4-4-4-12
 * hex UUID with a version nibble of 1-8 and a variant nibble of 8/9/a/b, or
 * the nil UUID (00000000-0000-0000-0000-000000000000) or the max UUID
 * (ffffffff-ffff-ffff-ffff-ffffffffffff) explicitly, in any case. Input is
 * case-insensitive; the returned id is always lowercase, so one shift has one
 * identity. `ShiftTaskTokenTest` mirrors the TypeScript cases one for one --
 * change both or neither.
 */
object ShiftTaskToken {
    const val PREFIX = "markiro:shift:v1:"

    // Accepts a well-formed UUID (version nibble 1-8, variant nibble 8/9/a/b), or the nil UUID
    // or the max UUID explicitly -- neither sentinel has a valid version/variant nibble, so each
    // is listed as its own accepted alternative. Matched only after lowercasing the input.
    private val UUID = Regex(
        "^(00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff|" +
            "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$",
    )

    /** The shift id this scan carries, or null when the scan is not a shift form. */
    fun parse(raw: String): String? {
        if (!raw.startsWith(PREFIX)) return null
        val id = raw.substring(PREFIX.length).lowercase()
        return if (UUID.matches(id)) id else null
    }
}
