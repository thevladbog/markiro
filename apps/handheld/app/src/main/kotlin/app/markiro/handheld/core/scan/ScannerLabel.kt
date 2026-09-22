package app.markiro.handheld.core.scan

import android.content.Context
import app.markiro.handheld.R
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject

/**
 * The scanner chip's text, shared by the hub and the work screen so the same
 * device is not «Urovo» on one and a bare «Сканер» on the other.
 */
class ScannerLabel @Inject constructor(
    @ApplicationContext private val context: Context,
    private val scan: ScanPreferences,
) {
    operator fun invoke(): String = when (scan.sourceKind) {
        ScanSourceKind.BUILTIN_INTENT -> VendorProfiles.byId(scan.profileId).label.substringBefore(" ·")
        ScanSourceKind.KEYBOARD_WEDGE -> context.getString(R.string.scanner_source_wedge)
        ScanSourceKind.DEBUG -> context.getString(R.string.scanner_source_debug)
    }
}
