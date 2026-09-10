package app.markiro.handheld.core.signal

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.km.Verdict
import app.markiro.handheld.feature.settings.AppPreferences
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SignallerTest {
    private class RecordingTones : TonePlayer {
        val played = mutableListOf<Triple<Double, Int, Wave>>()
        override fun play(hz: Double, millis: Int, wave: Wave, volume: Float) {
            played += Triple(hz, millis, wave)
        }
    }

    private class Buzzer : VibrationPort {
        val patterns = mutableListOf<LongArray>()
        override fun vibrate(pattern: LongArray) {
            patterns += pattern
        }
    }

    private val prefs = AppPreferences(ApplicationProvider.getApplicationContext())

    @Test
    fun mapsVerdictsToTheStationTones() {
        val tones = RecordingTones()
        val buzzer = Buzzer()
        val s = Signaller(prefs, tones, buzzer)
        s.play(Signaller.forVerdict(Verdict.OK))
        s.play(Signaller.forVerdict(Verdict.DUPLICATE))
        s.play(Signaller.forVerdict(Verdict.WRONG_GTIN))
        s.play(Signaller.forVerdict(Verdict.INVALID))
        assertEquals(
            listOf(
                Triple(880.0, 120, Wave.SINE),
                Triple(440.0, 300, Wave.TRIANGLE),
                Triple(220.0, 450, Wave.SQUARE),
                Triple(220.0, 450, Wave.SQUARE),
            ),
            tones.played,
        )
        assertEquals(listOf(0L, 40L), buzzer.patterns[0].toList())
        assertEquals(listOf(0L, 80L, 80L, 80L), buzzer.patterns[1].toList())
        assertEquals(listOf(0L, 150L, 100L, 150L), buzzer.patterns[2].toList())
    }

    @Test
    fun mutedOrSilentSkipsTonesAndVibrationCanBeOff() {
        val tones = RecordingTones()
        val buzzer = Buzzer()
        prefs.soundMuted = true
        prefs.vibrationEnabled = false
        Signaller(prefs, tones, buzzer).play(SignalKind.OK)
        assertTrue(tones.played.isEmpty())
        assertTrue(buzzer.patterns.isEmpty())
        prefs.soundMuted = false
        prefs.soundVolume = 0f
        Signaller(prefs, tones, buzzer).play(SignalKind.OK)
        assertTrue(tones.played.isEmpty())
    }

    @Test
    fun aBrokenAudioPathNeverThrows() {
        val broken = object : TonePlayer {
            override fun play(hz: Double, millis: Int, wave: Wave, volume: Float) = throw IllegalStateException("no audio")
        }
        val buzzer = object : VibrationPort {
            override fun vibrate(pattern: LongArray) = throw IllegalStateException("no vibrator")
        }
        prefs.soundMuted = false
        prefs.soundVolume = 1f
        prefs.vibrationEnabled = true
        Signaller(prefs, broken, buzzer).play(SignalKind.ERROR)
    }
}
