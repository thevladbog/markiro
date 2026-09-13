package app.markiro.handheld.core.grants

import android.os.SystemClock
import android.content.Context
import android.provider.Settings
import java.io.File

/** A missing OS boot identity denies strict work; wall time never substitutes for uptime. */
object AndroidGrantClock {
    fun sample(context: Context): ClockSample = sample().copy(bootId = runCatching {
        "android-boot:" + Settings.Global.getInt(context.contentResolver, Settings.Global.BOOT_COUNT).also { require(it >= 0) }
    }.getOrDefault(""))

    fun sample(): ClockSample = ClockSample(
        monotonicMs = SystemClock.elapsedRealtime(),
        bootId = runCatching { File("/proc/sys/kernel/random/boot_id").readText().trim() }.getOrDefault(""),
        wallMs = System.currentTimeMillis(),
    )
}
