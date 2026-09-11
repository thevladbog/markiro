package app.markiro.handheld.core.signal

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.VibrationEffect
import android.os.Vibrator
import app.markiro.handheld.core.km.Verdict
import app.markiro.handheld.feature.settings.AppPreferences
import kotlin.math.PI
import kotlin.math.asin
import kotlin.math.exp
import kotlin.math.sin

enum class Wave { SINE, SQUARE, TRIANGLE }

/**
 * The station's three tones (signal-sound.ts) with a haptic pattern each, plus
 * the handheld's fourth: a full box.
 *
 * `BOX_DONE` sits a fifth above `OK` and pulses twice, so a box completing is
 * never mistaken for one more accepted unit — the two land in the same second
 * and the operator is usually looking at the line, not the screen.
 */
enum class SignalKind(val hz: Double, val millis: Int, val wave: Wave, val vibration: LongArray) {
    OK(880.0, 120, Wave.SINE, longArrayOf(0, 40)),
    DUPLICATE(440.0, 300, Wave.TRIANGLE, longArrayOf(0, 80, 80, 80)),
    ERROR(220.0, 450, Wave.SQUARE, longArrayOf(0, 150, 100, 150)),
    BOX_DONE(1320.0, 90, Wave.SINE, longArrayOf(0, 40, 60, 40)),
}

interface TonePlayer {
    fun play(hz: Double, millis: Int, wave: Wave, volume: Float)
}

interface VibrationPort {
    fun vibrate(pattern: LongArray)
}

/** Every failure is swallowed so scanning never stops on a device with no audio or vibrator. */
class Signaller(private val prefs: AppPreferences, private val tones: TonePlayer, private val vibration: VibrationPort?) {
    fun play(kind: SignalKind) {
        val volume = prefs.soundVolume
        if (!prefs.soundMuted && volume > 0f) runCatching { tones.play(kind.hz, kind.millis, kind.wave, volume) }
        if (prefs.vibrationEnabled) runCatching { vibration?.vibrate(kind.vibration) }
    }

    companion object {
        fun forVerdict(verdict: Verdict): SignalKind = when (verdict) {
            Verdict.OK -> SignalKind.OK
            Verdict.DUPLICATE -> SignalKind.DUPLICATE
            Verdict.WRONG_GTIN, Verdict.INVALID -> SignalKind.ERROR
        }
    }
}

/** PCM synthesis through a static AudioTrack; the track releases itself when the marker is reached. */
class AudioTrackTonePlayer : TonePlayer {
    override fun play(hz: Double, millis: Int, wave: Wave, volume: Float) {
        val rate = 44_100
        val frames = rate * millis / 1000
        val pcm = ShortArray(frames)
        for (i in 0 until frames) {
            val x = 2.0 * PI * hz * i / rate
            val v = when (wave) {
                Wave.SINE -> sin(x)
                Wave.SQUARE -> if (sin(x) >= 0) 0.5 else -0.5
                Wave.TRIANGLE -> (2.0 / PI) * asin(sin(x))
            }
            val envelope = exp(-4.0 * i / frames)
            pcm[i] = (v * envelope * volume * 0.8 * Short.MAX_VALUE).toInt().toShort()
        }
        val track = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build(),
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(rate)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build(),
            )
            .setBufferSizeInBytes(frames * 2)
            .setTransferMode(AudioTrack.MODE_STATIC)
            .build()
        track.write(pcm, 0, frames)
        track.setNotificationMarkerPosition(frames)
        track.setPlaybackPositionUpdateListener(object : AudioTrack.OnPlaybackPositionUpdateListener {
            override fun onMarkerReached(t: AudioTrack) = t.release()
            override fun onPeriodicNotification(t: AudioTrack) = Unit
        })
        track.play()
    }
}

class SystemVibration(context: Context) : VibrationPort {
    private val vibrator: Vibrator? = context.getSystemService(Vibrator::class.java)

    override fun vibrate(pattern: LongArray) {
        vibrator?.vibrate(VibrationEffect.createWaveform(pattern, -1))
    }
}
