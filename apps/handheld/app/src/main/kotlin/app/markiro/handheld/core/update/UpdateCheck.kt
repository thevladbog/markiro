package app.markiro.handheld.core.update

import app.markiro.handheld.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request

/** The channel a terminal polls. `stable` is the only one a release build reads. */
const val UPDATE_CHANNEL_BASE_URL = "https://releases.markiro.app/handheld/stable"

/**
 * The published manifest, validated exactly as the publisher builds it.
 *
 * The device half of the contract is not a formality: this manifest decides
 * which bytes a terminal downloads and installs, and a field this build does
 * not fully recognise is a field nobody chose.
 */
@Serializable
data class UpdateManifest(
    val versionName: String,
    val versionCode: Int,
    val sha256: String,
    val bytes: Long,
    val url: String,
    val notes: String,
    val releasedAt: String,
    val sourceSha: String,
)

sealed interface UpdateState {
    data object UpToDate : UpdateState

    data class Available(val manifest: UpdateManifest) : UpdateState

    /**
     * No answer, for any reason: no route, a refusal, a manifest this build
     * does not recognise. Never a thrown exception -- a failed update check
     * must not reach the work screen, and «не знаю» is the honest state.
     */
    data class Unknown(val reason: Reason) : UpdateState

    enum class Reason { UNREACHABLE, REFUSED, MALFORMED }
}

private val SHA256 = Regex("^[0-9a-f]{64}$")
private val VERSION_NAME = Regex("^\\d+\\.\\d+\\.\\d+$")
private val COMMIT = Regex("^[0-9a-f]{40}$")

/** The one URL a version may be published at; compared, never trusted from the manifest. */
fun expectedArtifactUrl(versionName: String): String =
    "$UPDATE_CHANNEL_BASE_URL/releases/$versionName/markiro-tsd-$versionName.apk"

/** `null` when anything at all is off, so a caller cannot half-accept a manifest. */
fun parseUpdateManifest(json: Json, text: String): UpdateManifest? {
    val manifest = runCatching { json.decodeFromString(UpdateManifest.serializer(), text) }.getOrNull() ?: return null
    if (!VERSION_NAME.matches(manifest.versionName)) return null
    if (manifest.versionCode < 1) return null
    if (!SHA256.matches(manifest.sha256)) return null
    if (manifest.bytes < 1) return null
    if (!COMMIT.matches(manifest.sourceSha)) return null
    if (manifest.notes.isBlank()) return null
    // Compared to the exact URL this version publishes to. A prefix test would
    // accept `…/stable/../beta/…`, which starts in this channel and resolves in
    // another one, and this value is what the installer downloads.
    if (manifest.url != expectedArtifactUrl(manifest.versionName)) return null
    return manifest
}

class UpdateCheck(
    private val client: OkHttpClient,
    private val json: Json,
    private val manifestUrl: String = "$UPDATE_CHANNEL_BASE_URL/latest.json",
    private val installedVersionCode: Int = BuildConfig.VERSION_CODE,
) {
    suspend fun check(): UpdateState = withContext(Dispatchers.IO) {
        val request = Request.Builder().url(manifestUrl).header("Cache-Control", "no-cache").get().build()
        val body = try {
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return@withContext UpdateState.Unknown(UpdateState.Reason.REFUSED)
                response.body?.string()
            }
        } catch (_: Exception) {
            // Includes a terminal that simply has no route to the internet,
            // which on a factory floor is the ordinary case, not an error.
            return@withContext UpdateState.Unknown(UpdateState.Reason.UNREACHABLE)
        } ?: return@withContext UpdateState.Unknown(UpdateState.Reason.MALFORMED)

        val manifest = parseUpdateManifest(json, body)
            ?: return@withContext UpdateState.Unknown(UpdateState.Reason.MALFORMED)
        if (manifest.versionCode > installedVersionCode) {
            UpdateState.Available(manifest)
        } else {
            UpdateState.UpToDate
        }
    }
}
