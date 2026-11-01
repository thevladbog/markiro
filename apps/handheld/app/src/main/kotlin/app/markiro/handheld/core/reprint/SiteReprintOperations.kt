package app.markiro.handheld.core.reprint

sealed interface SiteReprintResult {
    data class Printed(val jobId: String, val description: String) : SiteReprintResult
    data class Failed(val code: String, val jobId: String? = null) : SiteReprintResult
    data class Unknown(val jobId: String, val description: String) : SiteReprintResult
    data object NotFound : SiteReprintResult
    data class Unavailable(val code: String) : SiteReprintResult
    data class Cancelled(val jobId: String) : SiteReprintResult
    data object Busy : SiteReprintResult
}

interface SiteReprintOperations {
    suspend fun print(raw: String, reason: String, sessionId: String, operatorId: String): SiteReprintResult
    suspend fun retry(jobId: String, operatorId: String): SiteReprintResult
    suspend fun cancel(jobId: String, operatorId: String): SiteReprintResult
    suspend fun verify(jobId: String, raw: String, operatorId: String): SiteReprintResult
    suspend fun pending(): SiteReprintJob?
    suspend fun refreshTemplates()
    suspend fun flushAudit()
}
