package app.markiro.handheld.core.auth

/** One row of the roster mirror the server delivers at pairing and on `GET /station/operators`. */
data class OperatorRecord(
    val operatorId: String,
    val name: String,
    val login: String,
    val role: String,
    val pinHash: String,
    val badgeHash: String?,
    val active: Boolean,
    /** The host's badges (an operator may hold several); the cloud's single [badgeHash] stays as it was. */
    val badgeHashes: List<String> = emptyList(),
)

interface OperatorRoster {
    suspend fun operators(): List<OperatorRecord>
}
