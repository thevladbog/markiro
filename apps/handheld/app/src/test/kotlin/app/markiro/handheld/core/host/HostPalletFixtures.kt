package app.markiro.handheld.core.host

import app.markiro.handheld.core.box.Sscc
import app.markiro.handheld.core.network.host.HostResult
import app.markiro.handheld.core.network.host.HostTransport
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MembershipStatus
import app.markiro.handheld.core.storage.PalletEntity
import app.markiro.handheld.core.storage.PalletKind
import app.markiro.handheld.core.storage.PalletMembershipEntity

/** Rows of the device's own warehouse pallets, in the shapes the app writes them. */
object HostPalletFixtures {
    const val PALLET = "a1000000-0000-4000-8000-000000000001"
    const val PRODUCT = "9f0e1d2c-3b4a-4958-8776-655443322110"
    const val OPERATOR = "c4a1e2b3-5d6f-4a7b-8c9d-0e1f2a3b4c5d"
    const val BOX_1 = "046006820000015000"
    const val BOX_2 = "046006820000015017"

    suspend fun pallet(db: HandheldDatabase, palletId: String = PALLET, closedAt: String? = null, sscc: String? = null) {
        db.palletDao().insert(
            PalletEntity(
                palletId = palletId, shiftId = null, terminalId = null, sscc = sscc, openedAt = "2026-10-08T07:00:00.000Z", closedAt = closedAt,
                operatorId = OPERATOR, printState = "pending", printReason = null, ackedAt = null, kind = PalletKind.WAREHOUSE, productId = PRODUCT, deviceId = "d1",
            ),
        )
    }

    suspend fun box(db: HandheldDatabase, sscc: String, at: String, palletId: String = PALLET) {
        db.palletMembershipDao().insert(
            PalletMembershipEntity(palletId, sscc, at, OPERATOR, MembershipStatus.PENDING, null, null, null, null, 12, "2026-10-08"),
        )
    }

    fun palletSscc(serial: Long) = Sscc.build(1, HostFactsFixtures.PREFIX, serial)

    /** Answers GET and POST by the path's start, scripted results in order; keeps every request as `"<path> <body>"`. */
    class Routes(private val answers: Map<String, ArrayDeque<HostResult>>) : HostTransport {
        val requests = mutableListOf<String>()

        private fun next(path: String, body: String): HostResult {
            requests += "$path $body"
            val queue = answers.entries.first { path.startsWith(it.key) }.value
            return if (queue.size > 1) queue.removeFirst() else queue.first()
        }

        override suspend fun get(path: String): HostResult = next(path, "")
        override suspend fun post(path: String, body: String): HostResult = next(path, body)
    }

    fun ok(body: String) = HostResult.Ok(200, body, null)

    fun routes(vararg pairs: Pair<String, List<HostResult>>) = Routes(pairs.associate { (k, v) -> k to ArrayDeque(v) })
}
