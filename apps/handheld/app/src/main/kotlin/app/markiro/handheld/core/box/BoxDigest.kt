package app.markiro.handheld.core.box

import java.security.MessageDigest

/** The domain's `boxMembershipDigestV1` (`box-digest.json`): SHA-256 of `markiro:box-members:v1\n` and the code hashes in byte order, joined by line feeds. */
object BoxDigest {
    fun of(codeHashes: List<String>): String {
        val text = "markiro:box-members:v1\n" + codeHashes.sorted().joinToString("\n")
        return MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }
}
