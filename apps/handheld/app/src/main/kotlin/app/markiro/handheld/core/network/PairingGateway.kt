package app.markiro.handheld.core.network

interface PairingGateway {
    suspend fun redeem(serverUrl: String, code: String): PairingResult
}
