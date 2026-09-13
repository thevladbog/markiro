package app.markiro.handheld.core.grants

const val JS_MAX_SAFE_INTEGER: Long = 9_007_199_254_740_991

enum class DeviceKind(val wire: String) { STATION("station"), HANDHELD("handheld"), KIOSK("kiosk") }
enum class GrantCapability(val wire: String) { SHIFT_START("shift.start.v1"), INVENTORY_START("inventory.start.v1"), PICKUP_START("pickup.start.v1") }
enum class GrantEventType(val wire: String) {
    SHIFT_SCAN("shift.scan.v1"), SHIFT_BOX_CLOSE("shift.box.close.v1"), SHIFT_PALLET_CLOSE("shift.pallet.close.v1"),
    SHIFT_LABEL_PREPARE("shift.label.prepare.v1"), SHIFT_CLOSE("shift.close.v1"), INVENTORY_SCAN("inventory.scan.v1"),
    INVENTORY_REPACK("inventory.repack.v1"), INVENTORY_BOX_CLOSE("inventory.box.close.v1"), INVENTORY_CLOSE("inventory.close.v1"),
    PICKUP_COMPLETE("pickup.complete.v1"),
}
enum class TaskKind(val wire: String) { SHIFT("shift"), INVENTORY("inventory"), PICKUP("pickup") }
enum class BudgetUnit(val wire: String) { EVENT("event"), UNIT("unit"), CONTAINER("container") }

data class GrantOwner(val tenantId: String, val deviceId: String, val kind: DeviceKind, val credentialEpoch: Long)
sealed interface OfflineGrant { val owner: GrantOwner; val issuer: String; val grantId: String; val entitlementRevision: String; val policyRevision: String; val issuedAt: Long; val notBefore: Long }
data class DeviceGrant(
    override val owner: GrantOwner, override val issuer: String, override val grantId: String,
    override val entitlementRevision: String, override val policyRevision: String, override val issuedAt: Long,
    override val notBefore: Long, val startNotAfter: Long, val capabilities: Set<GrantCapability>,
) : OfflineGrant
data class BudgetLine(val id: String, val unit: BudgetUnit, val maximum: Long)
data class TaskGrant(
    override val owner: GrantOwner, override val issuer: String, override val grantId: String,
    override val entitlementRevision: String, override val policyRevision: String, override val issuedAt: Long,
    override val notBefore: Long, val taskKind: TaskKind, val taskId: String, val snapshotDigest: String,
    val completeNotAfter: Long, val eventTypes: Set<GrantEventType>, val budget: List<BudgetLine>,
) : OfflineGrant

data class GrantIntent(
    val owner: GrantOwner, val capability: GrantCapability, val taskId: String, val snapshotDigest: String,
    val eventId: String, val eventType: GrantEventType, val cost: Map<String, Long>,
)
enum class DenialReason { MISSING_GRANT, WRONG_OWNER, NOT_YET_VALID, EXPIRED, WRONG_TASK, EVENT_FORBIDDEN, BUDGET_EXHAUSTED, CLOCK_UNTRUSTED }
sealed interface LocalDecision { data object Allow : LocalDecision; data class Deny(val reason: DenialReason) : LocalDecision }

internal fun safe(value: Long): Boolean = value in 0..JS_MAX_SAFE_INTEGER
