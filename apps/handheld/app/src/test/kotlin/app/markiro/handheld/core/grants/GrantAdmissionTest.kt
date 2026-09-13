package app.markiro.handheld.core.grants

import java.util.Base64
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

class GrantAdmissionTest {
    private val owner = GrantOwner("tenant", "device", DeviceKind.STATION, 1)
    private val intent = GrantIntent(owner, GrantCapability.SHIFT_START, "task", "snapshot", "event", GrantEventType.SHIFT_SCAN, mapOf("units" to 1))
    private val device = DeviceGrant(owner, "issuer", "grant", "e", "p", 100, 100, 200, setOf(GrantCapability.SHIFT_START))
    private val task = TaskGrant(owner, "issuer", "grant", "e", "p", 100, 100, TaskKind.SHIFT, "task", "snapshot", 200, setOf(GrantEventType.SHIFT_SCAN), listOf(BudgetLine("units", BudgetUnit.UNIT, 2)))

    @Test fun `matches shared admission vectors after successful verification`() {
        val fixture = Json.parseToJsonElement(checkNotNull(javaClass.classLoader?.getResourceAsStream("offline-grants-v1.json")).bufferedReader().use { it.readText() }).jsonObject
        val origin = "https://offline-grants.fixture.invalid"
        val publicKey = fixture.getValue("publicKey").jsonObject
        val verifier = GrantVerifier(listOf(VerificationKey(publicKey.getValue("kid").jsonPrimitive.content, origin, Base64.getDecoder().decode(publicKey.getValue("spkiDerBase64").jsonPrimitive.content))))
        val excluded = setOf("unsupported_algorithm", "unknown_key", "invalid_header", "issuer_mismatch")
        val reasons = mapOf(
            "owner_mismatch" to DenialReason.WRONG_OWNER, "snapshot_mismatch" to DenialReason.WRONG_TASK,
            "task_mismatch" to DenialReason.WRONG_TASK, "budget_unknown" to DenialReason.BUDGET_EXHAUSTED,
            "event_not_allowed" to DenialReason.EVENT_FORBIDDEN, "capability_not_allowed" to DenialReason.EVENT_FORBIDDEN,
            "not_yet_valid" to DenialReason.NOT_YET_VALID, "expired" to DenialReason.EXPIRED,
            "budget_exhausted" to DenialReason.BUDGET_EXHAUSTED,
        )
        fixture.getValue("vectors").jsonArray.forEach { element ->
            val vector = element.jsonObject; val expected = vector.getValue("expected").jsonObject
            val admission = expected.getValue("admission").jsonPrimitive.content
            if (expected.getValue("cryptographic").jsonPrimitive.content != "valid" || admission in excluded) return@forEach
            val input = vector.getValue("input").jsonObject; val context = input.getValue("context").jsonObject
            val verified = verifier.verify(input.getValue("compact").jsonPrimitive.content, context.getValue("issuer").jsonPrimitive.content) as VerifiedGrantResult.Valid
            val contextOwner = context.getValue("owner").jsonObject
            val actualOwner = GrantOwner(contextOwner.text("tenantId"), contextOwner.text("deviceId"), DeviceKind.entries.single { it.wire == contextOwner.text("kind") }, contextOwner.number("credentialEpoch"))
            val capability = context["capability"]?.jsonPrimitive?.content ?: "${context.text("taskKind")}.start.v1"
            val consumption = context["consumption"]?.jsonArray.orEmpty().map { it.jsonObject }
            val request = GrantIntent(
                actualOwner, GrantCapability.entries.single { it.wire == capability }, context["taskId"]?.jsonPrimitive?.content ?: "",
                context["snapshotDigest"]?.jsonPrimitive?.content ?: "", "event", GrantEventType.entries.single { it.wire == (context["eventType"]?.jsonPrimitive?.content ?: "shift.scan.v1") },
                consumption.associate { it.text("id") to it.number("requested") },
            )
            val decision = when (val grant = verified.grant) {
                is DeviceGrant -> GrantAdmission.assessNewWork(grant, request, context.number("now"))
                is TaskGrant -> GrantAdmission.assessCompletion(grant, request, context.number("now"), consumption.associate { it.text("id") to it.number("used") })
            }
            assertEquals(vector.getValue("id").jsonPrimitive.content, if (admission == "allow") LocalDecision.Allow else LocalDecision.Deny(checkNotNull(reasons[admission])), decision)
        }
    }

    @Test fun `uses exclusive deadlines and binds owner task snapshot event and capability`() {
        assertEquals(LocalDecision.Allow, GrantAdmission.assessNewWork(device, intent, 199))
        assertEquals(LocalDecision.Deny(DenialReason.EXPIRED), GrantAdmission.assessNewWork(device, intent, 200))
        assertEquals(LocalDecision.Deny(DenialReason.NOT_YET_VALID), GrantAdmission.assessCompletion(task, intent, 99, emptyMap()))
        assertEquals(LocalDecision.Allow, GrantAdmission.assessCompletion(task, intent, 199, emptyMap()))
        assertEquals(LocalDecision.Deny(DenialReason.WRONG_OWNER), GrantAdmission.assessCompletion(task, intent.copy(owner = owner.copy(deviceId = "other")), 100, emptyMap()))
        assertEquals(LocalDecision.Deny(DenialReason.WRONG_TASK), GrantAdmission.assessCompletion(task, intent.copy(snapshotDigest = "other"), 100, emptyMap()))
        assertEquals(LocalDecision.Deny(DenialReason.EVENT_FORBIDDEN), GrantAdmission.assessCompletion(task, intent.copy(eventType = GrantEventType.SHIFT_CLOSE), 100, emptyMap()))
    }

    @Test fun `fails closed for missing clock unknown budgets unsafe counters and exhaustion`() {
        assertEquals(LocalDecision.Deny(DenialReason.MISSING_GRANT), GrantAdmission.assessNewWork(null, intent, 100))
        assertEquals(LocalDecision.Deny(DenialReason.CLOCK_UNTRUSTED), GrantAdmission.assessCompletion(task, intent, null, emptyMap()))
        assertEquals(LocalDecision.Deny(DenialReason.BUDGET_EXHAUSTED), GrantAdmission.assessCompletion(task, intent.copy(cost = mapOf("unknown" to 1)), 100, emptyMap()))
        assertEquals(LocalDecision.Deny(DenialReason.BUDGET_EXHAUSTED), GrantAdmission.assessCompletion(task, intent, 100, mapOf("unknown" to 0)))
        assertEquals(LocalDecision.Deny(DenialReason.BUDGET_EXHAUSTED), GrantAdmission.assessCompletion(task, intent, 100, mapOf("units" to 2)))
        assertEquals(LocalDecision.Allow, GrantAdmission.assessCompletion(task.copy(budget = listOf(BudgetLine("units", BudgetUnit.UNIT, JS_MAX_SAFE_INTEGER))), intent, 100, mapOf("units" to JS_MAX_SAFE_INTEGER - 1)))
    }
}

private fun JsonObject.text(name: String) = getValue(name).jsonPrimitive.content
private fun JsonObject.number(name: String) = getValue(name).jsonPrimitive.content.toLong()
