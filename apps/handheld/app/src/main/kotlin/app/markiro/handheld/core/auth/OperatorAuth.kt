package app.markiro.handheld.core.auth

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Same rules as apps/station/src/lib/auth.ts: login first, one verification per attempt, active only. */
class OperatorAuth(
    private val roster: OperatorRoster,
    private val hashDispatcher: CoroutineDispatcher = Dispatchers.Default,
    private val verifier: (secret: String, phc: String) -> Boolean = PhcVerifier::verify,
) {
    suspend fun byLogin(login: String, pin: String): OperatorRecord? {
        if (!PIN.matches(pin)) return null
        if (!LOGIN.matches(login)) return null
        val operator = roster.operators().firstOrNull { it.active && it.login == login }
        // Verify against a dummy when the login is unknown so timing does not reveal valid logins.
        val ok = withContext(hashDispatcher) { verifier(pin, operator?.pinHash ?: DUMMY_PHC) }
        return if (ok) operator else null
    }

    /** Name lookup for the PIN step; no verification happens here. */
    suspend fun byLoginOnly(login: String): OperatorRecord? =
        roster.operators().firstOrNull { it.active && it.login == login }

    suspend fun byBadge(code: String): OperatorRecord? {
        if (code.isEmpty()) return null
        val candidates = roster.operators().filter { it.active && it.badgeHash != null }
        return withContext(hashDispatcher) {
            candidates.firstOrNull { verifier(code, it.badgeHash!!) }
        }
    }

    suspend fun search(prefix: String): List<OperatorRecord> {
        val needle = prefix.trim().lowercase()
        if (needle.isEmpty()) return emptyList()
        return roster.operators()
            .filter { it.active && it.name.lowercase().split(' ').any { word -> word.startsWith(needle) } }
            .take(5)
    }

    companion object {
        private val PIN = Regex("^\\d{4,6}$")
        private val LOGIN = Regex("^\\d{3,12}$")

        /** A structurally valid verifier whose plaintext is irrelevant; used to equalise work. */
        const val DUMMY_PHC =
            "pbkdf2\$sha256\$100000\$AAECAwQFBgcICQoLDA0ODw==\$hp5sg1DFvrCsw5n7qsO2DSIEM4lrJqZHc00NjxWG4fo="

        /** Pads 1–2 digit entries to the three-digit minimum; longer values keep their leading zeroes. */
        fun padLogin(login: String): String? {
            if (!Regex("^\\d{1,12}$").matches(login)) return null
            return login.padStart(3, '0')
        }
    }
}
