package app.markiro.handheld.core.update

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.security.MessageDigest

@RunWith(AndroidJUnit4::class)
class UpdateInstallerTest {
    private lateinit var server: MockWebServer
    private val context = ApplicationProvider.getApplicationContext<android.content.Context>()
    private val apk = "PK this stands in for a signed APK".toByteArray()
    private val sha256 = MessageDigest.getInstance("SHA-256").digest(apk).joinToString("") { "%02x".format(it) }

    @Before
    fun setUp() {
        server = MockWebServer().also { it.start() }
        File(context.cacheDir, "updates").deleteRecursively()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun manifest(sha: String = sha256, bytes: Long = apk.size.toLong()) = UpdateManifest(
        versionName = "0.5.0",
        versionCode = 5,
        sha256 = sha,
        bytes = bytes,
        url = server.url("/handheld/stable/releases/0.5.0/markiro-tsd-0.5.0.apk").toString(),
        notes = "Исправлена лента",
        releasedAt = "2026-09-12T10:00:00.000Z",
        sourceSha = "b".repeat(40),
    )

    private fun installer() = UpdateInstaller(context, OkHttpClient())

    private fun cached() = File(context.cacheDir, "updates/markiro-tsd-0.5.0.apk")

    @Test
    fun aMatchingDownloadIsReadyToInstall() = runTest {
        server.enqueue(MockResponse().setBody(Buffer().write(apk)))
        val result = installer().download(manifest())
        assertTrue(result is DownloadResult.Ready)
        assertEquals(apk.size.toLong(), (result as DownloadResult.Ready).file.length())
    }

    /**
     * The assertion that matters. A download truncated by factory Wi-Fi is
     * indistinguishable from a complete one by name, and an install prompt for
     * a broken APK is worse than no prompt at all.
     */
    @Test
    fun aTruncatedDownloadIsDeletedAndNeverOffered() = runTest {
        server.enqueue(MockResponse().setBody(Buffer().write(apk.copyOfRange(0, 10))))
        val result = installer().download(manifest())
        assertEquals(DownloadResult.Failed(DownloadResult.Failure.CORRUPT), result)
        assertFalse("a mismatched download must not be left on disk", cached().exists())
    }

    /** Right length, wrong bytes: only the digest catches this. */
    @Test
    fun bytesThatDoNotMatchTheDigestAreDeleted() = runTest {
        server.enqueue(MockResponse().setBody(Buffer().write(ByteArray(apk.size) { 7 })))
        assertEquals(
            DownloadResult.Failed(DownloadResult.Failure.CORRUPT),
            installer().download(manifest()),
        )
        assertFalse(cached().exists())
    }

    @Test
    fun aRefusalAndAnUnreachableServerAreToldApart() = runTest {
        server.enqueue(MockResponse().setResponseCode(404))
        assertEquals(
            DownloadResult.Failed(DownloadResult.Failure.REFUSED),
            installer().download(manifest()),
        )
        server.shutdown()
        assertEquals(
            DownloadResult.Failed(DownloadResult.Failure.UNREACHABLE),
            installer().download(manifest()),
        )
    }

    /** A leftover from an interrupted attempt must not be mistaken for this one. */
    @Test
    fun aStaleFileFromAnEarlierAttemptIsNotReused() = runTest {
        cached().parentFile?.mkdirs()
        cached().writeBytes("leftover".toByteArray())
        server.enqueue(MockResponse().setBody(Buffer().write(apk)))
        val result = installer().download(manifest())
        assertTrue(result is DownloadResult.Ready)
        assertEquals(sha256, MessageDigest.getInstance("SHA-256").digest(cached().readBytes()).joinToString("") { "%02x".format(it) })
    }
}
