package app.markiro.handheld.core.scan

import android.content.Context
import android.os.Build

class ScanPreferences(context: Context) {
    private val prefs = context.getSharedPreferences("scan", Context.MODE_PRIVATE)

    var sourceKind: ScanSourceKind
        get() = ScanSourceKind.valueOf(prefs.getString("source", ScanSourceKind.BUILTIN_INTENT.name)!!)
        set(value) {
            prefs.edit().putString("source", value.name).apply()
        }

    /** Only picks which setup hint the settings screen leads with; every profile is listened to. */
    var profileId: String
        get() = prefs.getString("profile", VendorProfiles.defaultFor(Build.MANUFACTURER ?: "").id)!!
        set(value) {
            prefs.edit().putString("profile", value).apply()
        }

    var customAction: String
        get() = prefs.getString("custom_action", "")!!
        set(value) = prefs.edit().putString("custom_action", value.trim()).apply()

    var customDataExtra: String
        get() = prefs.getString("custom_data", "")!!
        set(value) = prefs.edit().putString("custom_data", value.trim()).apply()

    var customSymbologyExtra: String
        get() = prefs.getString("custom_symbology", "")!!
        set(value) = prefs.edit().putString("custom_symbology", value.trim()).apply()

    /** Null until an operator has filled in both required fields. */
    fun customProfile(): VendorProfile? = VendorProfiles.custom(customAction, customDataExtra, customSymbologyExtra)
}
