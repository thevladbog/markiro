package app.markiro.handheld.core.network.host

import kotlinx.serialization.Serializable

@Serializable data class PackReasonDto(val id: String, val name: String)
@Serializable data class PackInspectionDto(
    val sscc: String, val kind: String, val productName: String, val boxes: Int,
    val units: Long, val status: String, val token: String, val reasons: List<PackReasonDto>,
)
@Serializable data class PackDisassembleDto(
    val requestId: String, val sscc: String, val operatorId: String, val reasonId: String, val expectedToken: String,
)
@Serializable data class PackDisassembledDto(
    val documentId: String, val docNo: String, val sscc: String, val kind: String,
    val boxes: Int, val codes: Long, val appliedAt: String,
)
