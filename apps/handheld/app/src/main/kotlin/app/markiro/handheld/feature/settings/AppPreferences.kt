package app.markiro.handheld.feature.settings

import android.content.Context

enum class ThemeMode { DARK, LIGHT, SYSTEM }

class AppPreferences(context: Context) {
    private val prefs = context.getSharedPreferences("app", Context.MODE_PRIVATE)

    var theme: ThemeMode
        get() = ThemeMode.valueOf(prefs.getString("theme", ThemeMode.DARK.name)!!)
        set(value) {
            prefs.edit().putString("theme", value.name).apply()
        }

    /** BCP-47 tag applied through AppCompatDelegate; `ru` is the default. */
    var language: String
        get() = prefs.getString("language", "ru")!!
        set(value) {
            prefs.edit().putString("language", value).apply()
        }
}
