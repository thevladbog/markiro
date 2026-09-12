package app.markiro.handheld.core.update

import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.security.MessageDigest

sealed interface DownloadResult {
    data class Ready(val file: File) : DownloadResult

    enum class Failure { UNREACHABLE, REFUSED, CORRUPT, NO_SPACE }

    data class Failed(val failure: Failure) : DownloadResult
}

/**
 * Downloads a published build and hands it to the system installer.
 *
 * Android will not install unattended without device-owner rights, so the
 * operator confirms the system dialogue. That confirmation is part of the
 * design; anything quieter needs the vendor's MDM and is a customer-side
 * decision.
 */
class UpdateInstaller(
    private val context: Context,
    private val client: OkHttpClient,
) {
    private fun target(manifest: UpdateManifest) =
        File(context.cacheDir, "updates/markiro-tsd-${manifest.versionName}.apk")

    suspend fun download(manifest: UpdateManifest): DownloadResult = withContext(Dispatchers.IO) {
        val file = target(manifest)
        // Never resumed and never reused: a partial file from an interrupted
        // download is indistinguishable from a complete one by name alone, and
        // the digest check below is the only thing standing between a truncated
        // APK and an install prompt.
        file.parentFile?.mkdirs()
        file.delete()
        try {
            client.newCall(Request.Builder().url(manifest.url).get().build()).execute().use { response ->
                if (!response.isSuccessful) return@withContext DownloadResult.Failed(DownloadResult.Failure.REFUSED)
                val body = response.body ?: return@withContext DownloadResult.Failed(DownloadResult.Failure.REFUSED)
                body.byteStream().use { input -> file.outputStream().use { output -> input.copyTo(output) } }
            }
        } catch (_: java.io.IOException) {
            file.delete()
            return@withContext DownloadResult.Failed(DownloadResult.Failure.UNREACHABLE)
        } catch (_: Exception) {
            file.delete()
            return@withContext DownloadResult.Failed(DownloadResult.Failure.NO_SPACE)
        }

        if (file.length() != manifest.bytes || sha256(file) != manifest.sha256) {
            // Deleted, not kept for a retry: a file that does not match the
            // manifest must never become an install prompt.
            file.delete()
            return@withContext DownloadResult.Failed(DownloadResult.Failure.CORRUPT)
        }
        DownloadResult.Ready(file)
    }

    /** The system dialogue; the operator decides. */
    fun installIntent(file: File): Intent {
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.updates", file)
        return Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { stream ->
            val buffer = ByteArray(1 shl 16)
            while (true) {
                val read = stream.read(buffer)
                if (read <= 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
}
