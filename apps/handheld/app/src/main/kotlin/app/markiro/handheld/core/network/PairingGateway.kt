package app.markiro.handheld.core.network

interface PairingGateway {
    suspend fun recover(serverUrl: String, code: String, expected: RecoveryIdentity): PairingResult
    suspend fun redeem(serverUrl: String, code: String): PairingResult
}
