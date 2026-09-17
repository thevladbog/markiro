package app.markiro.handheld.feature.shift

import app.markiro.handheld.R
import app.markiro.handheld.core.storage.ShiftEntity

/**
 * Why an aggregation shift on this device cannot number its boxes.
 *
 * Shown on the hub card and the work screen from entry, so the operator does
 * not learn it from a refused close on the twentieth scan. The two named
 * cases come from the bundle (`ShiftBundleDto.ssccIssuerProblem`) and say
 * where in the cabinet to fix it; the third covers every other reason the
 * server sent no block.
 */
enum class SsccWarning {
    ORG_GLN_MISSING,
    ISSUER_GLN_MISSING,
    NO_BLOCK,
}

/** Null outside aggregation, before a bundle has been fetched, or once a block has been cut. */
fun ShiftEntity.ssccWarning(): SsccWarning? {
    if (mode != "aggregation" || bundleFetchedAt == null || ssccIssuerPrefix != null) return null
    return when (ssccIssuerProblem) {
        "org_gln_missing" -> SsccWarning.ORG_GLN_MISSING
        "issuer_gln_missing" -> SsccWarning.ISSUER_GLN_MISSING
        else -> SsccWarning.NO_BLOCK
    }
}

fun SsccWarning.label(): Int = when (this) {
    SsccWarning.ORG_GLN_MISSING -> R.string.sscc_warning_org_gln
    SsccWarning.ISSUER_GLN_MISSING -> R.string.sscc_warning_issuer_gln
    SsccWarning.NO_BLOCK -> R.string.sscc_warning_no_block
}

/**
 * The server's refusal codes this build can say in words. `openShift` and
 * `enterShift` refuse to activate an aggregation shift whose issuer has no
 * GLN with exactly these codes (`apps/api/src/modules/sscc/sscc.service.ts`).
 */
fun ssccRefusalLabel(code: String?): Int? = when (code) {
    "ORG_GLN_MISSING" -> R.string.sscc_warning_org_gln
    "SSCC_ISSUER_GLN_MISSING" -> R.string.sscc_warning_issuer_gln
    else -> null
}
