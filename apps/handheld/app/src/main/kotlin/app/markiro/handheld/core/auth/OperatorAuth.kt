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

    suspend fun byBadge(code: String): OperatorRecord? = (checkBadge(code) as? BadgeCheck.Match)?.operator

    /** How many operators the mirror holds, blocked ones included: zero means the roster was never loaded (or the host has none). */
    suspend fun rosterSize(): Int = roster.operators().size

    /**
     * What a scan is, as the station reads it (`readBadgeScan`, apps/standalone/src/floor/sign-in.ts): trimmed, a product's code (it carries
     * the GS1 group separator), a code typed under another layout (Cyrillic) and anything that is not printable ASCII never reach the hash.
     * Then the code is matched against the active operators' badges; only when none matches is a blocked operator's badge looked for, so a
     * blocked person is told so instead of «not found». The answer is never silent: [BadgeCheck.EmptyRoster] says the mirror has nobody.
     */
    suspend fun checkBadge(raw: String): BadgeCheck {
        val code = raw.trim()
        if (code.contains(GROUP_SEPARATOR)) return BadgeCheck.Refused(NotABadge.PRODUCT_CODE)
        if (code.any { it in '\u0400'..'\u04FF' }) return BadgeCheck.Refused(NotABadge.LAYOUT)
        if (!BADGE_CODE.matches(code)) return BadgeCheck.Refused(NotABadge.NOT_BADGE)
        val all = roster.operators()
        if (all.isEmpty()) return BadgeCheck.EmptyRoster
        fun hashesOf(operator: OperatorRecord) = listOfNotNull(operator.badgeHash) + operator.badgeHashes
        return withContext(hashDispatcher) {
            val active = all.filter { it.active }.firstOrNull { operator -> hashesOf(operator).any { verifier(code, it) } }
            when {
                active != null -> BadgeCheck.Match(active)
                all.filter { !it.active }.any { operator -> hashesOf(operator).any { verifier(code, it) } } -> BadgeCheck.Blocked
                else -> BadgeCheck.Unknown
            }
        }
    }

    /** The personnel number against the mirror, no verification: found, blocked (the host or the cabinet turned the operator off), unknown or no roster. */
    suspend fun checkLogin(login: String): LoginCheck {
        val all = roster.operators()
        if (all.isEmpty()) return LoginCheck.EmptyRoster
        val named = all.filter { it.login == login }
        return when {
            named.any { it.active } -> LoginCheck.Found(named.first { it.active })
            named.isNotEmpty() -> LoginCheck.Blocked
            else -> LoginCheck.Unknown
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
        private const val GROUP_SEPARATOR = '\u001d'
        private val BADGE_CODE = Regex("^[ -~]{1,256}$")
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

/** Why a scan was not even tried as a badge. */
enum class NotABadge { PRODUCT_CODE, LAYOUT, NOT_BADGE }

sealed interface BadgeCheck {
    data class Match(val operator: OperatorRecord) : BadgeCheck
    data object Unknown : BadgeCheck
    data object Blocked : BadgeCheck
    data object EmptyRoster : BadgeCheck
    data class Refused(val reason: NotABadge) : BadgeCheck
}

sealed interface LoginCheck {
    data class Found(val operator: OperatorRecord) : LoginCheck
    data object Unknown : LoginCheck
    data object Blocked : LoginCheck
    data object EmptyRoster : LoginCheck
}
