package app.markiro.handheld.feature.work

import app.markiro.handheld.core.network.ParticipantDto
import app.markiro.handheld.core.network.StationApi

data class TeamState(val participants: List<ParticipantDto>, val acceptedUnits: Int?, val at: Long)

/** `GET /shifts/:id/summary`; null on any failure (403 until the device is a participant, offline, ...). */
fun interface TeamRefresher {
    suspend fun refresh(shiftId: String): TeamState?
}

class ApiTeamRefresher(private val api: StationApi, private val clock: () -> Long = System::currentTimeMillis) : TeamRefresher {
    override suspend fun refresh(shiftId: String): TeamState? = runCatching {
        val summary = api.summary(shiftId)
        TeamState(summary.participants, summary.output.acceptedUnits, clock())
    }.getOrNull()
}
