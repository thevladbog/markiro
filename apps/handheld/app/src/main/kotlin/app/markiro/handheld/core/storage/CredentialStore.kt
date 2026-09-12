package app.markiro.handheld.core.storage

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/** The device API key. Never logged, never in Room. */
interface CredentialStore {
    fun read(): String?
    fun write(apiKey: String)
    fun stage(publication: String)
    fun staged(): String?
    fun clearStaged()
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
        check(prefs.edit().putString(KEY, apiKey).commit()) { "Credential publication failed" }
    }

    override fun clear() {
        check(prefs.edit().remove(KEY).remove("publication").commit()) { "Credential removal failed" }
    }

    override fun stage(publication: String) { check(prefs.edit().putString("publication", publication).commit()) }
    override fun staged(): String? = prefs.getString("publication", null)
    override fun clearStaged() { check(prefs.edit().remove("publication").commit()) }

    private companion object {
        const val KEY = "api_key"
    }
}

class InMemoryCredentialStore : CredentialStore {
    private var value: String? = null
    private var publication: String? = null
    override fun stage(publication: String) { this.publication = publication }
    override fun staged(): String? = publication
    override fun clearStaged() { publication = null }
    override fun read(): String? = value
    override fun write(apiKey: String) {
        value = apiKey
    }
    override fun clear() {
        value = null
        publication = null
    }
}
