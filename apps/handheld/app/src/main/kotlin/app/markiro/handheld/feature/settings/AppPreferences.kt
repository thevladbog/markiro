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

    var soundMuted: Boolean
        get() = prefs.getBoolean("sound_muted", false)
        set(value) = prefs.edit().putBoolean("sound_muted", value).apply()

    /** 0..1 */
    var soundVolume: Float
        get() = prefs.getFloat("sound_volume", 1f)
        set(value) = prefs.edit().putFloat("sound_volume", value.coerceIn(0f, 1f)).apply()

    var vibrationEnabled: Boolean
        get() = prefs.getBoolean("vibration_enabled", true)
        set(value) = prefs.edit().putBoolean("vibration_enabled", value).apply()
}
