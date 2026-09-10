package app.markiro.handheld.core.scan

/** `raw` keeps the GS1 group separator (U+001D); `source` names the producing source for diagnostics. */
data class ScanEvent(val raw: String, val symbology: String?, val source: String, val at: Long)
