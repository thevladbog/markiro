package app.markiro.handheld.core.box

import app.markiro.handheld.core.storage.HandheldDatabase
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * The single lock the shift's pallet lifecycle is serialised by -- and, just
 * as importantly, the rule about WHERE it is taken.
 *
 * Opening a pallet, joining a box to it and closing it must not interleave.
 * Two coroutines each finding no open pallet would insert two, because the
 * handheld's `pallets` table carries only a non-unique `(shiftId, closedAt)`
 * index rather than the station's `pallets_mirror_open_terminal_uk`; and the
 * automatic close at capacity racing «Закрыть паллету досрочно» would each
 * burn a serial for the same pallet. `PalletRepository`, `ClosePallet` and
 * `CloseBox` therefore share ONE lock rather than holding a `Mutex` each,
 * which is also what makes an ordering rule expressible at all -- two private
 * mutexes have no order.
 *
 * The rule: **this lock is always taken BEFORE a database transaction, never
 * inside one.** The other order deadlocks. Room serialises writes, so a
 * coroutine holding the write transaction and waiting for this mutex, while
 * the coroutine holding the mutex waits for the write transaction, is the
 * classic ABBA shape. On a handheld that is not a crash an operator can report
 * -- it is «Закрыть» that never returns, on a line that cannot stop. So
 * [withLock] refuses the inverted order loudly instead, and a future caller
 * that reintroduces it fails on the first test run rather than on a floor.
 */
class PalletLock(private val db: HandheldDatabase) {
    private val mutex = Mutex()

    /**
     * Proof that the caller already holds the lock, obtainable only from
     * [withLock]. The methods that must run under it take one, so "assumes the
     * lock is already held" is a fact the compiler checks rather than a comment
     * the next caller can miss.
     */
    class Held internal constructor(internal val lock: PalletLock)

    /**
     * Runs [block] holding the lock, refusing if a transaction is already open
     * on this thread.
     */
    suspend fun <T> withLock(block: suspend (Held) -> T): T {
        requireNoTransaction("Taking the pallet lock")
        return mutex.withLock { block(Held(this)) }
    }

    /** One lock per database, so a token minted by another instance proves nothing about this one. */
    internal fun requireHeld(held: Held) = require(held.lock === this) {
        "This PalletLock.Held was minted by a different PalletLock and proves nothing about this one"
    }

    /**
     * The ordering pin. See the class comment: the inverted order deadlocks,
     * and a deadlocked close is a stopped line with no message at all, so this
     * fails immediately and by name instead.
     */
    internal fun requireNoTransaction(what: String) = check(!db.inTransaction()) {
        "$what must happen before a database transaction, never inside one: the inverted order " +
            "deadlocks against a caller holding the lock and waiting for the same transaction."
    }
}
