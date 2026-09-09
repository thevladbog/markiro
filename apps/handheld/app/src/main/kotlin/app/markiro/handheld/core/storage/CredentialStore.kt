package app.markiro.handheld.core.storage

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/** The device API key. Never logged, never in Room. */
interface CredentialStore {
    fun read(): String?
    fun write(apiKey: String)
    fun clear()
}

class EncryptedCredentialStore(context: Context) : CredentialStore {
    private val prefs: SharedPreferences by lazy {
        val key = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        EncryptedSharedPreferences.create(
            context,
            "handheld-credential",
            key,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    override fun read(): String? = prefs.getString(KEY, null)

    override fun write(apiKey: String) {
        prefs.edit().putString(KEY, apiKey).commit()
    }

    override fun clear() {
        prefs.edit().remove(KEY).commit()
    }

    private companion object {
        const val KEY = "api_key"
    }
}

class InMemoryCredentialStore : CredentialStore {
    private var value: String? = null
    override fun read(): String? = value
    override fun write(apiKey: String) {
        value = apiKey
    }
    override fun clear() {
        value = null
    }
}
