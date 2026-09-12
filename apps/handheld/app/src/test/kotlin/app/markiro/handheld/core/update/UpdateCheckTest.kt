package app.markiro.handheld.core.update

import app.markiro.handheld.core.network.NetworkModule
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class UpdateCheckTest {
    private lateinit var server: MockWebServer

    @Before
    fun setUp() {
        server = MockWebServer().also { it.start() }
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun manifest(
        versionCode: Int = 5,
        versionName: String = "0.5.0",
        url: String = expectedArtifactUrl(versionName),
        sha256: String = "a".repeat(64),
        notes: String = "Исправлена лента",
        sourceSha: String = "b".repeat(40),
        bytes: Long = 67_000_000,
    ) = """{"versionName":"$versionName","versionCode":$versionCode,"sha256":"$sha256",
        "bytes":$bytes,"url":"$url","notes":"$notes",
        "releasedAt":"2026-09-12T10:00:00.000Z","sourceSha":"$sourceSha"}"""

    private fun check(installed: Int = 4) = UpdateCheck(
        OkHttpClient(),
        NetworkModule.json(),
        manifestUrl = server.url("/handheld/stable/latest.json").toString(),
        installedVersionCode = installed,
    )

    @Test
    fun aHigherVersionCodeIsOffered() = runTest {
        server.enqueue(MockResponse().setBody(manifest(versionCode = 5)))
        val state = check(installed = 4).check()
        assertTrue(state is UpdateState.Available)
        assertEquals("0.5.0", (state as UpdateState.Available).manifest.versionName)
        assertEquals("Исправлена лента", state.manifest.notes)
    }

    /** `versionCode` is what the installer compares, and only it. */
    @Test
    fun theSameOrAnOlderVersionCodeIsNotOffered() = runTest {
        for (published in listOf(4, 3)) {
            server.enqueue(MockResponse().setBody(manifest(versionCode = published)))
            assertEquals(UpdateState.UpToDate, check(installed = 4).check())
        }
    }

    /**
     * A terminal on a factory floor is offline most of the time. That is the
     * ordinary case, and it must never reach the work screen as an error.
     */
    @Test
    fun anUnreachableServerIsUnknownAndDoesNotThrow() = runTest {
        server.shutdown()
        assertEquals(UpdateState.Unknown(UpdateState.Reason.UNREACHABLE), check().check())
    }

    @Test
    fun aRefusalIsUnknownAndDoesNotThrow() = runTest {
        server.enqueue(MockResponse().setResponseCode(403))
        assertEquals(UpdateState.Unknown(UpdateState.Reason.REFUSED), check().check())
    }

    @Test
    fun aManifestThisBuildDoesNotRecogniseIsNeverActedOn() = runTest {
        val bad = listOf(
            "not json",
            "{}",
            manifest(sha256 = "nope"),
            manifest(sourceSha = "short"),
            manifest(notes = "   "),
            manifest(bytes = 0),
            manifest(versionName = "0.5"),
        )
        for (body in bad) {
            server.enqueue(MockResponse().setBody(body))
            assertEquals(
                "accepted: $body",
                UpdateState.Unknown(UpdateState.Reason.MALFORMED),
                check().check(),
            )
        }
    }

    /**
     * The URL decides which bytes get installed. `../beta` starts inside this
     * channel and resolves in another one, and a prefix test would take it.
     */
    @Test
    fun aManifestPointingOutOfItsChannelIsRefused() = runTest {
        val outside = listOf(
            "https://releases.markiro.app/handheld/stable/releases/../../beta/releases/0.5.0/markiro-tsd-0.5.0.apk",
            "https://releases.markiro.app/handheld/beta/releases/0.5.0/markiro-tsd-0.5.0.apk",
            "https://evil.test/markiro-tsd-0.5.0.apk",
            "https://releases.markiro.app/handheld/stable/releases/0.5.0/other.apk",
        )
        for (url in outside) {
            server.enqueue(MockResponse().setBody(manifest(url = url)))
            assertEquals("accepted: $url", UpdateState.Unknown(UpdateState.Reason.MALFORMED), check().check())
        }
    }
}
