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

    var profileId: String
        get() = prefs.getString("profile", VendorProfiles.defaultFor(Build.MANUFACTURER ?: "").id)!!
        set(value) {
            prefs.edit().putString("profile", value).apply()
        }
}
