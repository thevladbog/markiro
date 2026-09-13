package app.markiro.handheld.core.grants

object GrantAdmission {
    private fun base(grant: OfflineGrant?, intent: GrantIntent, now: Long?): LocalDecision {
        if (grant == null) return LocalDecision.Deny(DenialReason.MISSING_GRANT)
        if (grant.owner != intent.owner) return LocalDecision.Deny(DenialReason.WRONG_OWNER)
        if (now == null || !safe(now)) return LocalDecision.Deny(DenialReason.CLOCK_UNTRUSTED)
        if (now < grant.notBefore) return LocalDecision.Deny(DenialReason.NOT_YET_VALID)
        val deadline = when (grant) { is DeviceGrant -> grant.startNotAfter; is TaskGrant -> grant.completeNotAfter }
        return if (now >= deadline) LocalDecision.Deny(DenialReason.EXPIRED) else LocalDecision.Allow
    }

    fun assessNewWork(grant: DeviceGrant?, intent: GrantIntent, now: Long?): LocalDecision {
        val base = base(grant, intent, now)
        if (base != LocalDecision.Allow || grant == null) return base
        return if (intent.capability in grant.capabilities) LocalDecision.Allow else LocalDecision.Deny(DenialReason.EVENT_FORBIDDEN)
    }

    fun assessCompletion(grant: TaskGrant?, intent: GrantIntent, now: Long?, consumed: Map<String, Long>): LocalDecision {
        val base = base(grant, intent, now)
        if (base != LocalDecision.Allow || grant == null) return base
        if (grant.taskId != intent.taskId || grant.snapshotDigest != intent.snapshotDigest || intent.capability.wire != "${grant.taskKind.wire}.start.v1") return LocalDecision.Deny(DenialReason.WRONG_TASK)
        if (intent.eventType !in grant.eventTypes) return LocalDecision.Deny(DenialReason.EVENT_FORBIDDEN)
        val maximums = grant.budget.associate { it.id to it.maximum }
        for ((id, used) in consumed) {
            val maximum = maximums[id] ?: return LocalDecision.Deny(DenialReason.BUDGET_EXHAUSTED)
            if (!safe(maximum) || !safe(used) || used > maximum) return LocalDecision.Deny(DenialReason.BUDGET_EXHAUSTED)
        }
        for ((id, cost) in intent.cost) {
            val maximum = maximums[id] ?: return LocalDecision.Deny(DenialReason.BUDGET_EXHAUSTED)
            val used = consumed[id] ?: 0
            if (!safe(maximum) || !safe(cost) || !safe(used) || used > maximum || cost > maximum - used) return LocalDecision.Deny(DenialReason.BUDGET_EXHAUSTED)
        }
        return LocalDecision.Allow
    }
}
