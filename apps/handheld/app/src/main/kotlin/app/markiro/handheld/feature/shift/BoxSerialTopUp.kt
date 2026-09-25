package app.markiro.handheld.feature.shift

import app.markiro.handheld.core.box.ServerRange
import app.markiro.handheld.core.box.SsccPool
import app.markiro.handheld.core.network.BoxSsccTopUpDto
import app.markiro.handheld.core.storage.GenerationToken
import app.markiro.handheld.core.storage.HandheldDatabase
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import retrofit2.HttpException

/** Background-only box serial check. A refusal never changes the local closing/printing path. */
class BoxSerialTopUp(
    private val db: HandheldDatabase,
    private val pool: SsccPool,
    private val shiftId: String,
    private val issuerPrefix: String,
    private val generation: GenerationToken,
    private val scope: CoroutineScope,
    private val request: suspend (String) -> BoxSsccTopUpDto,
) {
    private var inFlight: Job? = null
    private var retry: Job? = null
    private var periodic: Job? = null
    private var stopped = false
    private var unsupported = false
    private var failures = 0

    fun nudge(): Job? {
        if (stopped || unsupported || retry?.isActive == true) return null
        if (inFlight?.isActive == true) return inFlight
        periodic?.cancel()
        periodic = null
        inFlight = scope.launch {
            try {
                if (!current()) return@launch
                if (pool.remaining(issuerPrefix, SsccPool.BOX_EXTENSION_DIGIT) <= LOW_WATER) {
                    val response = request(shiftId)
                    validate(response)
                    // No HTTP or wait inside this lease. A credential rotation or shift switch
                    // between response and commit leaves the pool completely untouched.
                    db.recovery.commit(generation) {
                        if (!current()) return@commit
                        val liveStarts = response.blocks.map { it.fromSerial }.toSet()
                        pool.dropRanges(issuerPrefix, SsccPool.BOX_EXTENSION_DIGIT,
                            response.revokedFrom.filterNot { it in liveStarts })
                        response.blocks.forEach { block ->
                            pool.addRange(ServerRange(block.issuerPrefix, block.extensionDigit,
                                block.fromSerial, block.toSerial, block.consumedThroughSerial))
                        }
                    }
                }
                failures = 0
                periodic = scope.launch { delay(PERIODIC_MS); periodic = null; nudge() }
            } catch (e: CancellationException) {
                throw e
            } catch (e: HttpException) {
                if (e.code() == 404) unsupported = true else scheduleRetry()
            } catch (_: Exception) {
                scheduleRetry()
            } finally {
                inFlight = null
            }
        }
        return inFlight
    }

    fun stop() {
        stopped = true
        inFlight?.cancel()
        retry?.cancel()
        periodic?.cancel()
    }

    private suspend fun current(): Boolean = db.recovery.valid(generation) &&
        db.deviceConfigDao().get()?.activeShiftId == shiftId &&
        db.shiftDao().get(shiftId)?.let {
            it.status == "active" && it.mode == "aggregation" && it.ssccIssuerPrefix == issuerPrefix
        } == true

    private fun validate(response: BoxSsccTopUpDto) {
        require(response.revokedFrom.all { it >= 0 })
        response.blocks.forEach { block ->
            require(block.issuerPrefix == issuerPrefix && block.extensionDigit == SsccPool.BOX_EXTENSION_DIGIT)
            require(block.fromSerial >= 0 && block.toSerial >= block.fromSerial)
            require(block.consumedThroughSerial == null || block.consumedThroughSerial in (block.fromSerial - 1)..block.toSerial)
        }
        var lastEnd = -1L
        response.blocks.sortedBy { it.fromSerial }.forEach { block ->
            require(block.fromSerial > lastEnd)
            lastEnd = block.toSerial
        }
    }

    private fun scheduleRetry() {
        failures = (failures + 1).coerceAtMost(3)
        val wait = (RETRY_MS * (1 shl (failures - 1))).coerceAtMost(PERIODIC_MS)
        retry = scope.launch { delay(wait); retry = null; nudge() }
    }

    companion object {
        private const val LOW_WATER = 400L
        private const val RETRY_MS = 15_000L
        private const val PERIODIC_MS = 60_000L
    }
}
