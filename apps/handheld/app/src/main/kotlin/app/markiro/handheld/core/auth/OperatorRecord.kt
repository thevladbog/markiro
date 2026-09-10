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
)

interface OperatorRoster {
    suspend fun operators(): List<OperatorRecord>
}
