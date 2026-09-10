package app.markiro.handheld.core.scan

class IntentExtractor(private val profile: VendorProfile) {
    fun extract(extras: Map<String, Any?>, nowMs: Long): ScanEvent? {
        val data = extras[profile.dataExtra] as? String ?: return null
        val normalized = ScanNormalizer.normalize(data)
        if (normalized.isEmpty()) return null
        return ScanEvent(normalized, extras[profile.symbologyExtra] as? String, "intent:${profile.id}", nowMs)
    }
}
