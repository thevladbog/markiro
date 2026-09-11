# Handheld duplicate DataMatrix flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the handheld enter a shift whose validation policy prints a duplicate Data Matrix, and print, verify and reprint one per accepted unit — lifting the `validation-dm-duplicate-v1` refusal it carries today.

**Architecture:** Each accepted unit becomes a job. The job's bytes are rendered once from the policy's template snapshot and replayed forever after; its life is a sequence of events the server already understands, projected locally by a Kotlin port of the domain's state machine and queued through the same `POST /station/scans` batch as scans and box closures. One job is live at a time, so the operator always knows which sticker the screen is talking about.

**Tech Stack:** Kotlin 2.2, Jetpack Compose/Material3, Hilt, Room 2.7.2, kotlinx.serialization, JUnit 4 + Robolectric; `@markiro/domain` for the shared fixtures.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-11-handheld-duplicate-dm-design.md`. Read it before Task 1; every decision below comes from it.
- Target module is `apps/handheld`. **Run every Gradle command from `apps/handheld`**, and read every path in a `git add` as relative to it — except in Task 1, which also touches `packages/domain` and says so.
- `minSdk = 28`. Room is at **version 5**; this plan takes it to 6 with `MIGRATION_5_6`.
- Never write a raw control byte into a source file. The GS separator is `'\u001d'` as a `Char` and `"\u001d"` as a `String`, as `KmCodec.GS` already declares it.
- **Bytes are prepared once and replayed, never re-rendered.** This is the opposite of the box label, and the root `AGENTS.md` states both rules side by side.
- The server is not changed. `productLabelEvents` (cap `MAX_PRODUCT_LABEL_EVENTS` = 100, event ids unique per batch) and `productLabelReceipt` already exist in `apps/api/src/modules/station-scans/dto.ts`.
- Every user-visible string ships in both `app/src/main/res/values/strings.xml` and `app/src/main/res/values-en/strings.xml`. A missing translation is a lint error.
- Operator-facing text never shows a raw wire code; map it to a string resource, as `printReasonLabel` in `feature/work/BoxCloseScreens.kt:43` already does.
- Gates before completion, from `apps/handheld`:
  `./gradlew --no-daemon testDebugUnitTest lintDebug assembleDebug`
- Task 6 flips the capability string. Until it does, the app still refuses these shifts, which is correct: every task before it is inert in production.

---

### Task 1: The event projection and its fixtures

The state machine the server validates against, ported to Kotlin and pinned to `packages/domain` by a fifth fixture set — after the code parser, the inventory classifier, the label emitters and the box label's fields. Pure logic: no Room, no Android.

**Files:**

- Create: `packages/domain/src/product-labels/fixtures.ts`
- Create: `packages/domain/scripts/export-product-label-fixtures.mjs`
- Create: `packages/domain/test/product-label-fixtures.test.ts`
- Modify: `packages/domain/package.json` (scripts)
- Modify: `packages/domain/src/index.ts`
- Create: `apps/handheld/app/src/test/resources/product-label-fixtures.json` (generated)
- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/duplicate/DuplicateKm.kt`
- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/duplicate/ProductLabelEvents.kt`
- Test: `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/duplicate/ProductLabelFixturesTest.kt`

**Interfaces:**

- Consumes: `KmCodec.canonicalize`, `KmCodec.GS` from `app.markiro.handheld.core.km`.
- Produces, all in package `app.markiro.handheld.core.duplicate`:
  - `fun parseDuplicateKm(raw: String): ParsedKm` — throws `KmException("KM_REPRINT_INCOMPLETE", …)` when the crypto tail is absent
  - `fun compareDuplicateKm(expected: String, scanned: String): DuplicateMatch` where `enum class DuplicateMatch { MATCH, MISMATCH, INVALID }`
  - `fun duplicatePayloadDigest(raw: String): String`
  - `fun productLabelBytesDigest(bytes: ByteArray): String`
  - `data class ProductLabelProjection(jobId, shiftId, codeHash, acceptedAt, policyRevision, templateDigest, payloadDigest, bytesDigest, language, dpi, latestSequence, attemptId, attemptNo, attemptState, verification, verificationOutcome, status)` — all `String` except `dpi: Int`, `latestSequence: Int`, `attemptNo: Int`
  - `data class ProductLabelEvent(eventId, jobId, attemptId, sequence, shiftId, codeHash, acceptedAt, policyRevision, templateDigest, payloadDigest, operatorId, occurredAt, kind, attemptNo, reason, language, dpi, bytesDigest, errorCode, scannedPayloadDigest)` — a single `@Serializable` class whose kind-specific fields are nullable and omitted when null. **One `reason` field, not two:** the domain names both the reprint reason on `prepared` and the rejection reason on `verification_rejected` `reason`, and they never occur together.
  - `fun applyProductLabelEvent(current: ProductLabelProjection?, event: ProductLabelEvent, verification: String): ProductLabelProjection` — throws `ProductLabelTransitionException` on an invalid transition
  - `class ProductLabelTransitionException(message: String) : Exception(message)`

**Not ported, deliberately:** `productLabelValueDigest` and its canonical-JSON encoder. The device carries the policy's `snapshot.digest` through into every event; it never recomputes it. Recomputing would need a byte-exact canonical-JSON port whose only payoff is catching a corrupted local copy, and whose failure mode is refusing to print at all.

- [ ] **Step 1: Write the fixture builder**

Create `packages/domain/src/product-labels/fixtures.ts`:

```ts
import { compareDuplicateKm, duplicatePayloadDigest } from "./km.js";
import { applyProductLabelEvent } from "./state.js";
import type { ProductLabelEvent, VerificationPolicy } from "./contracts.js";
import type { ProductLabelProjection } from "./state.js";

const GS = String.fromCharCode(0x1d);
const RAW = `0104600682000013215Y7HG9${GS}93Zf8K`;
const OTHER = `0104600682000013215Y7HG8${GS}93Zf8K`;
const JOB = "11111111-1111-4111-8111-111111111111";
const ATTEMPT_1 = "22222222-2222-4222-8222-222222222222";
const ATTEMPT_2 = "33333333-3333-4333-8333-333333333333";
const SHIFT = "44444444-4444-4444-8444-444444444444";
const OPERATOR = "55555555-5555-4555-8555-555555555555";
const REVISION = "66666666-6666-4666-8666-666666666666";
const DIGEST = "a".repeat(64);
const BYTES = "b".repeat(64);

function base(sequence: number, attemptId: string) {
  return {
    eventId: `77777777-7777-4777-8777-${String(sequence).padStart(12, "0")}`,
    jobId: JOB,
    attemptId,
    sequence,
    shiftId: SHIFT,
    codeHash: "c".repeat(64),
    acceptedAt: "2026-09-11T08:00:00.000Z",
    policyRevision: REVISION,
    templateDigest: DIGEST,
    payloadDigest: duplicatePayloadDigest(RAW),
    operatorId: OPERATOR,
    occurredAt: "2026-09-11T08:00:01.000Z",
  };
}

function prepared(sequence: number, attemptId: string, attemptNo: number, reason: string | null) {
  return {
    ...base(sequence, attemptId),
    kind: "prepared",
    attemptNo,
    reason,
    language: "zpl",
    dpi: 203,
    bytesDigest: BYTES,
  } as ProductLabelEvent;
}

function simple(sequence: number, attemptId: string, kind: "sending" | "sent") {
  return { ...base(sequence, attemptId), kind } as ProductLabelEvent;
}

function unknown(sequence: number, attemptId: string, errorCode: string) {
  return { ...base(sequence, attemptId), kind: "delivery_unknown", errorCode } as ProductLabelEvent;
}

function failed(sequence: number, attemptId: string, errorCode: string) {
  return {
    ...base(sequence, attemptId),
    kind: "failed_before_send",
    errorCode,
  } as ProductLabelEvent;
}

function verified(sequence: number, attemptId: string, digest: string) {
  return {
    ...base(sequence, attemptId),
    kind: "verified",
    scannedPayloadDigest: digest,
  } as ProductLabelEvent;
}

function rejected(sequence: number, attemptId: string, reason: "invalid" | "mismatch") {
  return {
    ...base(sequence, attemptId),
    kind: "verification_rejected",
    reason,
  } as ProductLabelEvent;
}

interface Case {
  name: string;
  verification: VerificationPolicy;
  events: ProductLabelEvent[];
  /** Index of the first event the domain refuses, or null when the whole run applies. */
  invalidAt: number | null;
  projection: ProductLabelProjection | null;
}

function run(name: string, verification: VerificationPolicy, events: ProductLabelEvent[]): Case {
  let projection: ProductLabelProjection | null = null;
  for (let index = 0; index < events.length; index++) {
    try {
      projection = applyProductLabelEvent(projection, events[index]!, verification);
    } catch {
      return { name, verification, events, invalidAt: index, projection };
    }
  }
  return { name, verification, events, invalidAt: null, projection };
}

export function buildProductLabelFixtures() {
  const cases: Case[] = [
    run("printed under no verification", "none", [
      prepared(1, ATTEMPT_1, 1, null),
      simple(2, ATTEMPT_1, "sending"),
      simple(3, ATTEMPT_1, "sent"),
    ]),
    run("awaiting verification", "required", [
      prepared(1, ATTEMPT_1, 1, null),
      simple(2, ATTEMPT_1, "sending"),
      simple(3, ATTEMPT_1, "sent"),
    ]),
    run("verified", "required", [
      prepared(1, ATTEMPT_1, 1, null),
      simple(2, ATTEMPT_1, "sending"),
      simple(3, ATTEMPT_1, "sent"),
      verified(4, ATTEMPT_1, duplicatePayloadDigest(RAW)),
    ]),
    run("a rejected verification settles nothing", "required", [
      prepared(1, ATTEMPT_1, 1, null),
      simple(2, ATTEMPT_1, "sending"),
      simple(3, ATTEMPT_1, "sent"),
      rejected(4, ATTEMPT_1, "mismatch"),
    ]),
    run("an unknown delivery is resolved by a scan under no verification", "none", [
      prepared(1, ATTEMPT_1, 1, null),
      simple(2, ATTEMPT_1, "sending"),
      unknown(3, ATTEMPT_1, "transport_failed"),
      verified(4, ATTEMPT_1, duplicatePayloadDigest(RAW)),
    ]),
    run("an interrupted send needs attention", "none", [
      prepared(1, ATTEMPT_1, 1, null),
      simple(2, ATTEMPT_1, "sending"),
      unknown(3, ATTEMPT_1, "interrupted"),
    ]),
    run("nothing was sent", "none", [
      prepared(1, ATTEMPT_1, 1, null),
      failed(2, ATTEMPT_1, "printer_changed"),
    ]),
    run("a reprint replays the same bytes", "none", [
      prepared(1, ATTEMPT_1, 1, null),
      simple(2, ATTEMPT_1, "sending"),
      simple(3, ATTEMPT_1, "sent"),
      prepared(4, ATTEMPT_2, 2, "damaged"),
      simple(5, ATTEMPT_2, "sending"),
      simple(6, ATTEMPT_2, "sent"),
    ]),
    // A verified label can still be damaged or lost afterwards, so the job
    // takes a new attempt -- and under `required` the reprint drops back to
    // `pending`, because the new sticker has to be scanned back in its turn.
    run("a completed job still takes a reprint, which must be verified again", "required", [
      prepared(1, ATTEMPT_1, 1, null),
      simple(2, ATTEMPT_1, "sending"),
      simple(3, ATTEMPT_1, "sent"),
      verified(4, ATTEMPT_1, duplicatePayloadDigest(RAW)),
      prepared(5, ATTEMPT_2, 2, "lost"),
    ]),
    // What IS frozen is the verified attempt: nothing may be appended to it.
    run("a verified attempt takes no further event of its own", "required", [
      prepared(1, ATTEMPT_1, 1, null),
      simple(2, ATTEMPT_1, "sending"),
      simple(3, ATTEMPT_1, "sent"),
      verified(4, ATTEMPT_1, duplicatePayloadDigest(RAW)),
      rejected(5, ATTEMPT_1, "mismatch"),
    ]),
    run("a gap in the sequence is refused", "none", [
      prepared(1, ATTEMPT_1, 1, null),
      simple(3, ATTEMPT_1, "sending"),
    ]),
    run("a reprint may not change the bytes", "none", [
      prepared(1, ATTEMPT_1, 1, null),
      simple(2, ATTEMPT_1, "sending"),
      simple(3, ATTEMPT_1, "sent"),
      { ...prepared(4, ATTEMPT_2, 2, "damaged"), bytesDigest: "d".repeat(64) } as ProductLabelEvent,
    ]),
    run("a reprint may not start while an attempt is in flight", "none", [
      prepared(1, ATTEMPT_1, 1, null),
      simple(2, ATTEMPT_1, "sending"),
      prepared(3, ATTEMPT_2, 2, "damaged"),
    ]),
    run("a verification carrying the wrong digest is refused", "required", [
      prepared(1, ATTEMPT_1, 1, null),
      simple(2, ATTEMPT_1, "sending"),
      simple(3, ATTEMPT_1, "sent"),
      verified(4, ATTEMPT_1, duplicatePayloadDigest(OTHER)),
    ]),
  ];

  return {
    projection: cases,
    compare: [
      { name: "same code", expected: RAW, scanned: RAW, result: compareDuplicateKm(RAW, RAW) },
      {
        name: "a different unit of the same product",
        expected: RAW,
        scanned: OTHER,
        result: compareDuplicateKm(RAW, OTHER),
      },
      {
        name: "the identity without its crypto tail is NOT a match",
        expected: RAW,
        scanned: "0104600682000013215Y7HG9",
        result: compareDuplicateKm(RAW, "0104600682000013215Y7HG9"),
      },
      {
        name: "unreadable",
        expected: RAW,
        scanned: "garbage",
        result: compareDuplicateKm(RAW, "garbage"),
      },
    ],
    payloadDigest: [RAW, OTHER].map((raw) => ({ raw, digest: duplicatePayloadDigest(raw) })),
  };
}
```

- [ ] **Step 2: Export it and pin it**

Create `packages/domain/scripts/export-product-label-fixtures.mjs`:

```js
// Writes the product-label fixtures the handheld's Kotlin tests consume. Runs
// against the built package (`pnpm --filter @markiro/domain
// fixtures:product-labels` builds first) because the sources use `.js` import
// specifiers that Node's type stripping does not rewrite.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const { buildProductLabelFixtures } = await import("../dist/product-labels/fixtures.js");

const target = fileURLToPath(
  new URL(
    "../../../apps/handheld/app/src/test/resources/product-label-fixtures.json",
    import.meta.url,
  ),
);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, JSON.stringify(buildProductLabelFixtures(), null, 2) + "\n");
console.log(`wrote ${target}`);
```

In `packages/domain/package.json`, add to `"scripts"` next to the existing `fixtures:box-labels` entry:

```json
"fixtures:product-labels": "pnpm build && node scripts/export-product-label-fixtures.mjs"
```

In `packages/domain/src/index.ts`, next to the other `product-labels` exports, add:

```ts
export { buildProductLabelFixtures } from "./product-labels/fixtures.js";
```

Create `packages/domain/test/product-label-fixtures.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildProductLabelFixtures } from "../src/product-labels/fixtures.js";

const fixturePath = fileURLToPath(
  new URL(
    "../../../apps/handheld/app/src/test/resources/product-label-fixtures.json",
    import.meta.url,
  ),
);

describe("product label fixtures shared with the handheld", () => {
  it("match the committed JSON byte for byte", () => {
    // Regenerate with `pnpm --filter @markiro/domain fixtures:product-labels`.
    // Failing here means the Kotlin port is pinned to something this package
    // no longer produces.
    expect(readFileSync(fixturePath, "utf8")).toBe(
      JSON.stringify(buildProductLabelFixtures(), null, 2) + "\n",
    );
  });

  it("cover both policies, every refusal, and every terminal status", () => {
    const fixtures = buildProductLabelFixtures();
    const statuses = new Set(fixtures.projection.map((c) => c.projection?.status));
    for (const status of ["prepared", "sending", "awaiting_verification", "completed", "attention"])
      expect(statuses, status).toContain(status);
    expect(fixtures.projection.filter((c) => c.invalidAt !== null).length).toBeGreaterThanOrEqual(
      5,
    );
    expect(new Set(fixtures.compare.map((c) => c.result))).toEqual(
      new Set(["match", "mismatch", "invalid"]),
    );
  });

  it("prove the crypto tail is part of the comparison", () => {
    // The identity hash the scan loop uses would call this a match. This one
    // must not, or a duplicate of a different unit would verify.
    const fixtures = buildProductLabelFixtures();
    const stripped = fixtures.compare.find((c) => c.name.includes("crypto tail"));
    expect(stripped?.result).toBe("invalid");
  });
});
```

- [ ] **Step 3: Generate the fixtures and run the domain gates**

Run, from the repository root:

```bash
pnpm --filter @markiro/domain fixtures:product-labels
pnpm --filter @markiro/domain test
pnpm --filter @markiro/domain typecheck
pnpm --filter @markiro/domain lint
pnpm --filter @markiro/domain build
```

Expected: the fixture file is written, then all four gates pass.

- [ ] **Step 4: Write the failing Kotlin test**

Create `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/duplicate/ProductLabelFixturesTest.kt`:

```kotlin
package app.markiro.handheld.core.duplicate

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the Kotlin projection to `packages/domain`. The server validates the same
 * events, so a disagreement here is a batch the server will quarantine.
 */
class ProductLabelFixturesTest {
    private val json = Json { ignoreUnknownKeys = true }
    private val fixtures: JsonObject = Json.parseToJsonElement(
        checkNotNull(javaClass.classLoader?.getResource("product-label-fixtures.json")) {
            "run pnpm --filter @markiro/domain fixtures:product-labels"
        }.readText(),
    ).jsonObject

    @Test
    fun everyProjectionCaseAgrees() {
        val cases = fixtures.getValue("projection").jsonArray
        assertTrue(cases.size >= 14)
        for (element in cases) {
            val case = element.jsonObject
            val name = case.getValue("name").jsonPrimitive.content
            val verification = case.getValue("verification").jsonPrimitive.content
            val events = case.getValue("events").jsonArray.map {
                json.decodeFromJsonElement(ProductLabelEvent.serializer(), it)
            }
            val invalidAt = case.getValue("invalidAt").jsonPrimitive.let { if (it.content == "null") null else it.int }

            var projection: ProductLabelProjection? = null
            var refusedAt: Int? = null
            for ((index, event) in events.withIndex()) {
                try {
                    projection = applyProductLabelEvent(projection, event, verification)
                } catch (_: ProductLabelTransitionException) {
                    refusedAt = index
                    break
                }
            }
            assertEquals("$name: refusal index", invalidAt, refusedAt)

            val expected = case.getValue("projection")
            if (expected is kotlinx.serialization.json.JsonNull) {
                assertNull(name, projection)
                continue
            }
            val o = expected.jsonObject
            val p = checkNotNull(projection) { "$name: no projection" }
            assertEquals("$name: status", o.getValue("status").jsonPrimitive.content, p.status)
            assertEquals("$name: attemptState", o.getValue("attemptState").jsonPrimitive.content, p.attemptState)
            assertEquals(
                "$name: verificationOutcome",
                o.getValue("verificationOutcome").jsonPrimitive.content,
                p.verificationOutcome,
            )
            assertEquals("$name: attemptNo", o.getValue("attemptNo").jsonPrimitive.int, p.attemptNo)
            assertEquals("$name: latestSequence", o.getValue("latestSequence").jsonPrimitive.int, p.latestSequence)
            assertEquals("$name: attemptId", o.getValue("attemptId").jsonPrimitive.content, p.attemptId)
        }
    }

    @Test
    fun theComparisonAgreesIncludingTheCryptoTail() {
        for (element in fixtures.getValue("compare").jsonArray) {
            val case = element.jsonObject
            val name = case.getValue("name").jsonPrimitive.content
            val expected = when (case.getValue("result").jsonPrimitive.content) {
                "match" -> DuplicateMatch.MATCH
                "mismatch" -> DuplicateMatch.MISMATCH
                else -> DuplicateMatch.INVALID
            }
            assertEquals(
                name,
                expected,
                compareDuplicateKm(
                    case.getValue("expected").jsonPrimitive.content,
                    case.getValue("scanned").jsonPrimitive.content,
                ),
            )
        }
    }

    @Test
    fun thePayloadDigestAgrees() {
        for (element in fixtures.getValue("payloadDigest").jsonArray) {
            val case = element.jsonObject
            assertEquals(
                case.getValue("digest").jsonPrimitive.content,
                duplicatePayloadDigest(case.getValue("raw").jsonPrimitive.content),
            )
        }
    }
}
```

- [ ] **Step 5: Run it to verify it fails**

Run: `./gradlew --no-daemon testDebugUnitTest --tests '*ProductLabelFixturesTest*'`
Expected: FAIL — compilation error, `Unresolved reference: ProductLabelEvent`.

- [ ] **Step 6: Write the KM helpers**

Create `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/duplicate/DuplicateKm.kt`:

```kotlin
package app.markiro.handheld.core.duplicate

import app.markiro.handheld.core.km.KmCodec
import app.markiro.handheld.core.km.KmException
import app.markiro.handheld.core.km.ParsedKm
import java.security.MessageDigest

enum class DuplicateMatch { MATCH, MISMATCH, INVALID }

/**
 * Eligibility for duplication, not a check of the crypto signature's
 * authenticity: a code with no crypto tail cannot be reproduced as a valid
 * marking code, so it must never reach a label.
 */
fun parseDuplicateKm(raw: String): ParsedKm {
    val km = KmCodec.canonicalize(raw)
    val complete = km.ais["93"] != null || (km.ais["91"] != null && km.ais["92"] != null)
    if (!complete) throw KmException("KM_REPRINT_INCOMPLETE", "Complete marking code required")
    return km
}

/**
 * Compares the FULL raw code, separators and crypto tail included -- unlike
 * `KmCodec.hash`, which deliberately drops the tail so two scans of one physical
 * item collide. Using the identity here would accept a different unit of the
 * same product as a valid verification.
 */
fun compareDuplicateKm(expected: String, scanned: String): DuplicateMatch {
    // A damaged saved payload is a storage failure, not an operator mismatch, so
    // it is not caught here.
    val canonicalExpected = parseDuplicateKm(expected).canonicalRaw
    return try {
        if (parseDuplicateKm(scanned).canonicalRaw == canonicalExpected) DuplicateMatch.MATCH else DuplicateMatch.MISMATCH
    } catch (_: KmException) {
        DuplicateMatch.INVALID
    }
}

fun productLabelBytesDigest(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

fun duplicatePayloadDigest(raw: String): String =
    productLabelBytesDigest(parseDuplicateKm(raw).canonicalRaw.toByteArray(Charsets.UTF_8))
```

- [ ] **Step 7: Write the event projection**

Create `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/duplicate/ProductLabelEvents.kt`:

```kotlin
package app.markiro.handheld.core.duplicate

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable

class ProductLabelTransitionException(message: String) : Exception(message)

/** The protocol `validation-dm-duplicate-v1` names; the server checks it against this exact string. */
const val PRODUCT_LABEL_PROTOCOL = "validation-dm-duplicate-v1"

/**
 * One wire event.
 *
 * The domain models these as a discriminated union; one nullable-field class is
 * the shape kotlinx.serialization encodes without a custom serializer, and the
 * nulls are omitted so the JSON matches the schema, which is `.strictObject()`
 * per kind and would reject a stray field.
 */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class ProductLabelEvent(
    val eventId: String,
    val jobId: String,
    val attemptId: String,
    val sequence: Int,
    val shiftId: String,
    val codeHash: String,
    val acceptedAt: String,
    val policyRevision: String,
    val templateDigest: String,
    val payloadDigest: String,
    val operatorId: String,
    val occurredAt: String,
    val kind: String,
    val attemptNo: Int? = null,
    val reason: String? = null,
    val language: String? = null,
    val dpi: Int? = null,
    val bytesDigest: String? = null,
    val errorCode: String? = null,
    val scannedPayloadDigest: String? = null,
)

/** Immutable origin and print context alongside the current attempt's state. */
data class ProductLabelProjection(
    val jobId: String,
    val shiftId: String,
    val codeHash: String,
    val acceptedAt: String,
    val policyRevision: String,
    val templateDigest: String,
    val payloadDigest: String,
    val bytesDigest: String,
    val language: String,
    val dpi: Int,
    val latestSequence: Int,
    val attemptId: String,
    val attemptNo: Int,
    val attemptState: String,
    val verification: String,
    val verificationOutcome: String,
    val status: String,
)

object AttemptState {
    const val PREPARED = "prepared"
    const val SENDING = "sending"
    const val SENT = "sent"
    const val FAILED_BEFORE_SEND = "failed_before_send"
    const val DELIVERY_UNKNOWN = "delivery_unknown"
}

object JobStatus {
    const val PREPARED = "prepared"
    const val SENDING = "sending"
    const val AWAITING_VERIFICATION = "awaiting_verification"
    const val COMPLETED = "completed"
    const val ATTENTION = "attention"
}

object Verification {
    const val NONE = "none"
    const val REQUIRED = "required"
}

object VerificationOutcome {
    const val NOT_REQUIRED = "not_required"
    const val PENDING = "pending"
    const val VERIFIED = "verified"
}

/** Port of `productLabelStatus` in packages/domain/src/product-labels/state.ts. */
fun productLabelStatus(attempt: String, verification: String, verified: Boolean): String {
    if (verified) {
        if (attempt != AttemptState.SENT && attempt != AttemptState.DELIVERY_UNKNOWN) invalidTransition()
        return JobStatus.COMPLETED
    }
    return when (attempt) {
        AttemptState.PREPARED -> JobStatus.PREPARED
        AttemptState.SENDING -> JobStatus.SENDING
        AttemptState.SENT -> if (verification == Verification.REQUIRED) JobStatus.AWAITING_VERIFICATION else JobStatus.COMPLETED
        else -> JobStatus.ATTENTION
    }
}

private fun invalidTransition(): Nothing =
    throw ProductLabelTransitionException("Product label event does not follow the current attempt")

private val ORIGIN_MATCHES: (ProductLabelProjection, ProductLabelEvent) -> Boolean = { c, e ->
    c.jobId == e.jobId && c.shiftId == e.shiftId && c.codeHash == e.codeHash &&
        c.acceptedAt == e.acceptedAt && c.policyRevision == e.policyRevision &&
        c.templateDigest == e.templateDigest && c.payloadDigest == e.payloadDigest
}

/** Port of `canApplyProductLabelEvent`. Storage handles replay by event id before calling this. */
fun canApplyProductLabelEvent(current: ProductLabelProjection, event: ProductLabelEvent): Boolean {
    if (event.sequence != current.latestSequence + 1 || !ORIGIN_MATCHES(current, event)) return false

    if (event.kind == "prepared") {
        return current.attemptState != AttemptState.SENDING &&
            current.attemptState != AttemptState.PREPARED &&
            event.attemptId != current.attemptId &&
            event.attemptNo == current.attemptNo + 1 &&
            event.reason != null &&
            event.bytesDigest == current.bytesDigest &&
            event.language == current.language &&
            event.dpi == current.dpi
    }
    if (event.attemptId != current.attemptId || current.verificationOutcome == VerificationOutcome.VERIFIED) return false

    return when (event.kind) {
        "sending", "failed_before_send" -> current.attemptState == AttemptState.PREPARED
        "sent", "delivery_unknown" -> current.attemptState == AttemptState.SENDING
        "verified", "verification_rejected" -> {
            val canVerify = current.attemptState == AttemptState.DELIVERY_UNKNOWN ||
                (current.attemptState == AttemptState.SENT && current.verification == Verification.REQUIRED)
            canVerify && (event.kind != "verified" || event.scannedPayloadDigest == current.payloadDigest)
        }
        else -> false
    }
}

/** Port of `applyProductLabelEvent`. */
fun applyProductLabelEvent(
    current: ProductLabelProjection?,
    event: ProductLabelEvent,
    verification: String,
): ProductLabelProjection {
    if (current == null) {
        if (event.kind != "prepared" || event.sequence != 1 || event.attemptNo != 1 || event.reason != null) invalidTransition()
        return ProductLabelProjection(
            jobId = event.jobId,
            shiftId = event.shiftId,
            codeHash = event.codeHash,
            acceptedAt = event.acceptedAt,
            policyRevision = event.policyRevision,
            templateDigest = event.templateDigest,
            payloadDigest = event.payloadDigest,
            bytesDigest = checkNotNull(event.bytesDigest) { "prepared without bytesDigest" },
            language = checkNotNull(event.language) { "prepared without language" },
            dpi = checkNotNull(event.dpi) { "prepared without dpi" },
            latestSequence = 1,
            attemptId = event.attemptId,
            attemptNo = 1,
            attemptState = AttemptState.PREPARED,
            verification = verification,
            verificationOutcome = if (verification == Verification.REQUIRED) {
                VerificationOutcome.PENDING
            } else {
                VerificationOutcome.NOT_REQUIRED
            },
            status = JobStatus.PREPARED,
        )
    }
    if (current.verification != verification || !canApplyProductLabelEvent(current, event)) invalidTransition()
    if (event.kind == "prepared") {
        return current.copy(
            latestSequence = event.sequence,
            attemptId = event.attemptId,
            attemptNo = checkNotNull(event.attemptNo) { "prepared without attemptNo" },
            attemptState = AttemptState.PREPARED,
            status = JobStatus.PREPARED,
            verificationOutcome = if (verification == Verification.REQUIRED) {
                VerificationOutcome.PENDING
            } else {
                VerificationOutcome.NOT_REQUIRED
            },
        )
    }
    val attemptState = if (event.kind == "verified" || event.kind == "verification_rejected") current.attemptState else event.kind
    val outcome = if (event.kind == "verified") VerificationOutcome.VERIFIED else current.verificationOutcome
    return current.copy(
        latestSequence = event.sequence,
        attemptState = attemptState,
        verificationOutcome = outcome,
        status = productLabelStatus(attemptState, verification, outcome == VerificationOutcome.VERIFIED),
    )
}
```

- [ ] **Step 8: Run the Kotlin test to verify it passes**

Run: `./gradlew --no-daemon testDebugUnitTest --tests '*ProductLabelFixturesTest*'`
Expected: PASS, 3 tests.

- [ ] **Step 9: Record the new fixture set**

In `apps/handheld/AGENTS.md`, in the list of fixture generators under "Shared protocol and domain parity", add to the fenced block:

```bash
pnpm --filter @markiro/domain fixtures:product-labels
```

- [ ] **Step 10: Commit**

```bash
cd ../.. && git add packages/domain apps/handheld/app/src/test/resources/product-label-fixtures.json apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/duplicate apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/duplicate apps/handheld/AGENTS.md && git commit -m "feat(handheld): port the product-label event projection with a fifth fixture set" && cd apps/handheld
```

---

### Task 2: Storage and the policy

Room goes to version 6: the shift row learns the duplicate policy, and two new tables hold the jobs and their events. Nothing prints yet.

**Files:**

- Modify: `app/src/main/kotlin/app/markiro/handheld/core/network/ShiftDtos.kt:7`
- Modify: `app/src/main/kotlin/app/markiro/handheld/core/storage/ShiftEntities.kt:40`
- Create: `app/src/main/kotlin/app/markiro/handheld/core/storage/ProductLabelEntities.kt`
- Create: `app/src/main/kotlin/app/markiro/handheld/core/storage/ProductLabelDaos.kt`
- Modify: `app/src/main/kotlin/app/markiro/handheld/core/storage/Migrations.kt`
- Modify: `app/src/main/kotlin/app/markiro/handheld/core/storage/HandheldDatabase.kt:29`
- Modify: `app/src/main/kotlin/app/markiro/handheld/core/storage/DeviceWipe.kt:12`
- Modify: `app/src/main/kotlin/app/markiro/handheld/feature/shift/ShiftRepository.kt:63`
- Modify: `app/src/main/kotlin/app/markiro/handheld/core/storage/StorageModule.kt` (register the migration)
- Test: `app/src/test/kotlin/app/markiro/handheld/core/storage/ProductLabelStorageTest.kt`
- Test: `app/src/test/kotlin/app/markiro/handheld/core/storage/MigrationTest.kt` (add a case)
- Test: `app/src/test/kotlin/app/markiro/handheld/feature/shift/ShiftRepositoryTest.kt` (add a case)

**Interfaces:**

- Consumes: nothing from Task 1.
- Produces:
  - `ShiftEntity` gains `duplicateVerification: String?`, `duplicateTemplate: String?`, `duplicateTemplateDigest: String?`, `duplicatePolicyRevision: String?`
  - `ProductLabelJobEntity(jobId, shiftId, codeHash, canonicalRaw, acceptedAt, operatorId, policyRevision, templateDigest, payloadDigest, bytesBase64, bytesDigest, language, dpi, latestSequence, attemptId, attemptNo, attemptState, verification, verificationOutcome, status)`
  - `ProductLabelEventEntity(eventId, jobId, sequence, kind, payloadJson, occurredAt, ackedAt, quarantineCode)`
  - `ProductLabelJobDao` with `insert`, `update`, `get`, `observeOpen(shiftId)`, `openJob(shiftId)`, `dropBytesForShift(shiftId)`, `purgeSettled(shiftId)`, `clear`
  - `ProductLabelEventDao` with `insert`, `unacked(limit)`, `observeUnackedCount()`, `markAcked(ids, at)`, `markQuarantined(id, code, at)`, `bySequence(jobId)`, `clear`
  - `MIGRATION_5_6`

**Why two tables rather than the inventory's event+outbox pair:** an event's payload is fixed and small, so a second table would hold a copy of the same JSON keyed the same way. The `boxes` table already sets the precedent in this app — `ackedAt` on the row itself is the queue.

- [ ] **Step 1: Write the failing storage test**

Create `app/src/test/kotlin/app/markiro/handheld/core/storage/ProductLabelStorageTest.kt`:

```kotlin
package app.markiro.handheld.core.storage

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ProductLabelStorageTest {
    private lateinit var db: HandheldDatabase

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
    }

    @After
    fun tearDown() = db.close()

    private fun job(id: String, status: String = "prepared") = ProductLabelJobEntity(
        jobId = id,
        shiftId = "s1",
        codeHash = "c".repeat(64),
        canonicalRaw = "0104600682000013215Y7HG9",
        acceptedAt = "2026-09-11T08:00:00.000Z",
        operatorId = "op-1",
        policyRevision = "rev-1",
        templateDigest = "a".repeat(64),
        payloadDigest = "p".repeat(64),
        bytesBase64 = "AAEC",
        bytesDigest = "b".repeat(64),
        language = "zpl",
        dpi = 203,
        latestSequence = 1,
        attemptId = "att-1",
        attemptNo = 1,
        attemptState = "prepared",
        verification = "none",
        verificationOutcome = "not_required",
        status = status,
    )

    private fun event(id: String, jobId: String, sequence: Int) = ProductLabelEventEntity(
        eventId = id,
        jobId = jobId,
        sequence = sequence,
        kind = "prepared",
        payloadJson = """{"eventId":"$id"}""",
        occurredAt = "2026-09-11T08:00:00.000Z",
        ackedAt = null,
        quarantineCode = null,
    )

    @Test
    fun anOpenJobIsTheOneThatIsNotSettled() = runTest {
        db.productLabelJobDao().insert(job("j1", status = "completed"))
        assertNull(db.productLabelJobDao().openJob("s1"))
        db.productLabelJobDao().insert(job("j2", status = "sending"))
        assertEquals("j2", db.productLabelJobDao().openJob("s1")?.jobId)
    }

    @Test
    fun eventsDrainOldestFirstAndAcknowledgeById() = runTest {
        db.productLabelJobDao().insert(job("j1"))
        db.productLabelEventDao().insert(event("e2", "j1", 2))
        db.productLabelEventDao().insert(event("e1", "j1", 1))
        assertEquals(listOf("e1", "e2"), db.productLabelEventDao().unacked(10).map { it.eventId })
        db.productLabelEventDao().markAcked(listOf("e1"), "2026-09-11T09:00:00.000Z")
        assertEquals(listOf("e2"), db.productLabelEventDao().unacked(10).map { it.eventId })
    }

    @Test
    fun aQuarantinedEventLeavesTheQueueButKeepsItsCode() = runTest {
        db.productLabelJobDao().insert(job("j1"))
        db.productLabelEventDao().insert(event("e1", "j1", 1))
        db.productLabelEventDao().markQuarantined("e1", "policy_mismatch", "2026-09-11T09:00:00.000Z")
        assertEquals(emptyList<String>(), db.productLabelEventDao().unacked(10).map { it.eventId })
        assertEquals("policy_mismatch", db.productLabelEventDao().bySequence("j1").single().quarantineCode)
    }

    /** Retention step one: the bytes go at shift close whatever the status. */
    @Test
    fun closingAShiftDropsTheBytesAndKeepsTheRow() = runTest {
        db.productLabelJobDao().insert(job("j1", status = "attention"))
        db.productLabelJobDao().dropBytesForShift("s1")
        val row = assertNotNull(db.productLabelJobDao().get("j1"))
        assertNull(db.productLabelJobDao().get("j1")?.bytesBase64)
        assertEquals("b".repeat(64), db.productLabelJobDao().get("j1")?.bytesDigest)
    }

    /** Retention step two: the row goes once the server has every event. */
    @Test
    fun purgingKeepsAJobWhoseEventsAreStillOwed() = runTest {
        db.productLabelJobDao().insert(job("j1", status = "completed"))
        db.productLabelJobDao().insert(job("j2", status = "completed"))
        db.productLabelEventDao().insert(event("e1", "j1", 1))
        db.productLabelEventDao().insert(event("e2", "j2", 1).copy(ackedAt = "2026-09-11T09:00:00.000Z"))
        db.productLabelJobDao().purgeSettled("s1")
        assertNotNull(db.productLabelJobDao().get("j1"))
        assertNull(db.productLabelJobDao().get("j2"))
        assertEquals(listOf("e1"), db.productLabelEventDao().bySequence("j1").map { it.eventId })
    }

    /** The whole "no credential scoping" decision rests on this. */
    @Test
    fun aWipeLeavesNoJobAndNoEvent() = runTest {
        db.productLabelJobDao().insert(job("j1", status = "attention"))
        db.productLabelEventDao().insert(event("e1", "j1", 1))
        db.productLabelJobDao().clear()
        db.productLabelEventDao().clear()
        assertNull(db.productLabelJobDao().get("j1"))
        assertEquals(emptyList<String>(), db.productLabelEventDao().bySequence("j1").map { it.eventId })
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./gradlew --no-daemon testDebugUnitTest --tests '*ProductLabelStorageTest*'`
Expected: FAIL — compilation error, `Unresolved reference: ProductLabelJobEntity`.

- [ ] **Step 3: Write the entities**

Create `app/src/main/kotlin/app/markiro/handheld/core/storage/ProductLabelEntities.kt`:

```kotlin
package app.markiro.handheld.core.storage

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * One accepted unit's duplicate label.
 *
 * `bytesBase64` is the prepared document, replayed on every attempt and never
 * re-rendered: a reprint must reproduce the same symbol, and the digest the
 * server holds is over these bytes. It is dropped at shift close, because a
 * reprint into a closed shift is not a thing and a shift's worth of labels would
 * grow without bound on a fixed disk. `bytesDigest` survives that, so an already
 * queued event still describes what was printed.
 */
@Entity(tableName = "product_label_jobs", indices = [Index(value = ["shiftId", "status"])])
data class ProductLabelJobEntity(
    @PrimaryKey val jobId: String,
    val shiftId: String,
    val codeHash: String,
    /** The canonical marking code, the source of both the symbol and the verification comparison. */
    val canonicalRaw: String,
    val acceptedAt: String,
    val operatorId: String,
    val policyRevision: String,
    val templateDigest: String,
    val payloadDigest: String,
    val bytesBase64: String?,
    val bytesDigest: String,
    val language: String,
    val dpi: Int,
    val latestSequence: Int,
    val attemptId: String,
    val attemptNo: Int,
    val attemptState: String,
    val verification: String,
    val verificationOutcome: String,
    val status: String,
)

/**
 * The job's event log and its outbox at once. An event's payload is fixed and
 * small, so a second table would hold the same JSON under the same key; `boxes`
 * already sets this precedent with its own `ackedAt`.
 */
@Entity(
    tableName = "product_label_events",
    indices = [
        Index(value = ["jobId", "sequence"], unique = true),
        Index(value = ["ackedAt"]),
    ],
)
data class ProductLabelEventEntity(
    @PrimaryKey val eventId: String,
    val jobId: String,
    val sequence: Int,
    val kind: String,
    /** The exact wire object, so a retry resends byte-identical JSON. */
    val payloadJson: String,
    val occurredAt: String,
    val ackedAt: String?,
    /** Set when the server answered `quarantined`; the event leaves the queue but stays visible. */
    val quarantineCode: String?,
)
```

- [ ] **Step 4: Write the DAOs**

Create `app/src/main/kotlin/app/markiro/handheld/core/storage/ProductLabelDaos.kt`:

```kotlin
package app.markiro.handheld.core.storage

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.Query
import androidx.room.Update
import kotlinx.coroutines.flow.Flow

@Dao
interface ProductLabelJobDao {
    @Insert
    suspend fun insert(job: ProductLabelJobEntity)

    @Update
    suspend fun update(job: ProductLabelJobEntity)

    @Query("SELECT * FROM product_label_jobs WHERE jobId = :jobId")
    suspend fun get(jobId: String): ProductLabelJobEntity?

    /**
     * The one job the next trigger pull is about. A `completed` job is at rest
     * -- the protocol still accepts a reprint of one, but nothing a scan does
     * concerns it -- and every other status is outstanding, which is why this
     * is a negative test rather than a list of live statuses.
     */
    @Query("SELECT * FROM product_label_jobs WHERE shiftId = :shiftId AND status <> 'completed' ORDER BY acceptedAt LIMIT 1")
    suspend fun openJob(shiftId: String): ProductLabelJobEntity?

    @Query("SELECT * FROM product_label_jobs WHERE shiftId = :shiftId AND status <> 'completed' ORDER BY acceptedAt LIMIT 1")
    fun observeOpen(shiftId: String): Flow<ProductLabelJobEntity?>

    /** Anything the app left mid-send is unknown, never resumable. */
    @Query("SELECT * FROM product_label_jobs WHERE attemptState = 'sending'")
    suspend fun interrupted(): List<ProductLabelJobEntity>

    /** Retention, step one: the bytes exist only for a reprint, and a closed shift takes no reprints. */
    @Query("UPDATE product_label_jobs SET bytesBase64 = NULL WHERE shiftId = :shiftId")
    suspend fun dropBytesForShift(shiftId: String)

    /** Retention, step two: the row goes once the server holds every one of its events. */
    @Query(
        "DELETE FROM product_label_jobs WHERE shiftId = :shiftId AND status = 'completed' AND NOT EXISTS (" +
            "SELECT 1 FROM product_label_events WHERE product_label_events.jobId = product_label_jobs.jobId " +
            "AND ackedAt IS NULL AND quarantineCode IS NULL)",
    )
    suspend fun purgeSettled(shiftId: String)

    @Query("DELETE FROM product_label_jobs")
    suspend fun clear()
}

@Dao
interface ProductLabelEventDao {
    @Insert
    suspend fun insert(event: ProductLabelEventEntity)

    /**
     * Oldest first across every job. The server refuses a gap in a job's
     * sequence, so the order is the contract, not a preference.
     */
    @Query(
        "SELECT * FROM product_label_events WHERE ackedAt IS NULL AND quarantineCode IS NULL " +
            "ORDER BY occurredAt, jobId, sequence LIMIT :limit",
    )
    suspend fun unacked(limit: Int): List<ProductLabelEventEntity>

    @Query("SELECT COUNT(*) FROM product_label_events WHERE ackedAt IS NULL AND quarantineCode IS NULL")
    fun observeUnackedCount(): Flow<Int>

    @Query("UPDATE product_label_events SET ackedAt = :at WHERE eventId IN (:eventIds)")
    suspend fun markAcked(eventIds: List<String>, at: String)

    @Query("UPDATE product_label_events SET quarantineCode = :code, ackedAt = :at WHERE eventId = :eventId")
    suspend fun markQuarantined(eventId: String, code: String, at: String)

    @Query("SELECT * FROM product_label_events WHERE jobId = :jobId ORDER BY sequence")
    suspend fun bySequence(jobId: String): List<ProductLabelEventEntity>

    @Query("SELECT COUNT(*) FROM product_label_events WHERE quarantineCode IS NOT NULL")
    fun observeQuarantinedCount(): Flow<Int>

    @Query("DELETE FROM product_label_events")
    suspend fun clear()
}
```

- [ ] **Step 5: Add the shift's policy columns**

In `app/src/main/kotlin/app/markiro/handheld/core/storage/ShiftEntities.kt`, after the `ssccIssuerPrefix` property, add:

```kotlin
    /** `none` or `required`; null when the shift prints no duplicate. */
    val duplicateVerification: String? = null,

    /** The duplicate template's spec as the bundle delivered it, and the digest that pins its revision. */
    val duplicateTemplate: String? = null,
    val duplicateTemplateDigest: String? = null,
    val duplicatePolicyRevision: String? = null,
```

- [ ] **Step 6: Write the migration**

In `app/src/main/kotlin/app/markiro/handheld/core/storage/Migrations.kt`, append:

```kotlin
/** Duplicate printing: the shift's policy snapshot, its jobs and their events. */
val MIGRATION_5_6 = object : Migration(5, 6) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL("ALTER TABLE `shift_mirror` ADD COLUMN `duplicateVerification` TEXT")
        db.execSQL("ALTER TABLE `shift_mirror` ADD COLUMN `duplicateTemplate` TEXT")
        db.execSQL("ALTER TABLE `shift_mirror` ADD COLUMN `duplicateTemplateDigest` TEXT")
        db.execSQL("ALTER TABLE `shift_mirror` ADD COLUMN `duplicatePolicyRevision` TEXT")
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `product_label_jobs` (`jobId` TEXT NOT NULL, `shiftId` TEXT NOT NULL, " +
                "`codeHash` TEXT NOT NULL, `canonicalRaw` TEXT NOT NULL, `acceptedAt` TEXT NOT NULL, " +
                "`operatorId` TEXT NOT NULL, `policyRevision` TEXT NOT NULL, `templateDigest` TEXT NOT NULL, " +
                "`payloadDigest` TEXT NOT NULL, `bytesBase64` TEXT, `bytesDigest` TEXT NOT NULL, " +
                "`language` TEXT NOT NULL, `dpi` INTEGER NOT NULL, `latestSequence` INTEGER NOT NULL, " +
                "`attemptId` TEXT NOT NULL, `attemptNo` INTEGER NOT NULL, `attemptState` TEXT NOT NULL, " +
                "`verification` TEXT NOT NULL, `verificationOutcome` TEXT NOT NULL, `status` TEXT NOT NULL, " +
                "PRIMARY KEY(`jobId`))",
        )
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_product_label_jobs_shiftId_status` ON `product_label_jobs` (`shiftId`, `status`)")
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `product_label_events` (`eventId` TEXT NOT NULL, `jobId` TEXT NOT NULL, " +
                "`sequence` INTEGER NOT NULL, `kind` TEXT NOT NULL, `payloadJson` TEXT NOT NULL, " +
                "`occurredAt` TEXT NOT NULL, `ackedAt` TEXT, `quarantineCode` TEXT, PRIMARY KEY(`eventId`))",
        )
        db.execSQL(
            "CREATE UNIQUE INDEX IF NOT EXISTS `index_product_label_events_jobId_sequence` " +
                "ON `product_label_events` (`jobId`, `sequence`)",
        )
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_product_label_events_ackedAt` ON `product_label_events` (`ackedAt`)")
    }
}
```

- [ ] **Step 7: Register the version, the entities, the DAOs, the migration and the wipe**

In `app/src/main/kotlin/app/markiro/handheld/core/storage/HandheldDatabase.kt`, add to the `entities` array after `SsccRangeEntity::class`:

```kotlin
        ProductLabelJobEntity::class,
        ProductLabelEventEntity::class,
```

change `version = 5` to `version = 6`, and add next to the other abstract DAOs:

```kotlin
    abstract fun productLabelJobDao(): ProductLabelJobDao
    abstract fun productLabelEventDao(): ProductLabelEventDao
```

In `app/src/main/kotlin/app/markiro/handheld/core/storage/StorageModule.kt`, find the `addMigrations(...)` call and append `MIGRATION_5_6` to its argument list.

In `app/src/main/kotlin/app/markiro/handheld/core/storage/DeviceWipe.kt`, add inside the transaction, immediately after `db.ssccPoolDao().clear()`:

```kotlin
            // The duplicate flow has no credential-ownership column precisely
            // because a revoked device keeps nothing. That is only true while
            // these two lines are here.
            db.productLabelEventDao().clear()
            db.productLabelJobDao().clear()
```

- [ ] **Step 8: Run the storage test to verify it passes**

Run: `./gradlew --no-daemon testDebugUnitTest --tests '*ProductLabelStorageTest*'`
Expected: PASS, 6 tests.

- [ ] **Step 9: Add the migration test**

Open `app/src/test/kotlin/app/markiro/handheld/core/storage/MigrationTest.kt` and read how the existing v4→v5 case is written: it seeds a database at the old version with `FrameworkSQLiteOpenHelperFactory` and drives `MIGRATION_4_5` directly, because building the database through Room would create the schema from the entities and never run the migration at all.

Add a case in the same shape that:

1. creates a v5 database and inserts one `shift_mirror` row with the v5 column list,
2. runs `MIGRATION_5_6`,
3. asserts the shift row survived and `duplicateVerification` reads as null,
4. asserts `INSERT` into `product_label_jobs` and `product_label_events` succeeds,
5. asserts a second `product_label_events` row with the same `(jobId, sequence)` is rejected by the unique index.

- [ ] **Step 10: Parse and keep the policy**

In `app/src/main/kotlin/app/markiro/handheld/core/network/ShiftDtos.kt`, replace the `ValidationPrintDto` declaration with:

```kotlin
/** The duplicate template snapshot; `spec` is the label geometry the device renders from. */
@Serializable
data class DuplicateTemplateDto(val id: String, val name: String, val spec: JsonElement, val digest: String)

/**
 * `mode` is `none` or `duplicate_dm`. Every other field is present only in the
 * second case, and the server refuses to snapshot a policy without them.
 */
@Serializable
data class ValidationPrintDto(
    val mode: String,
    val verification: String? = null,
    val snapshot: DuplicateTemplateDto? = null,
    val policyRevision: String? = null,
)
```

In `app/src/main/kotlin/app/markiro/handheld/feature/shift/ShiftRepository.kt`, inside `toEntity`, after the `ssccIssuerPrefix = existing?.ssccIssuerPrefix,` line add:

```kotlin
    duplicateVerification = existing?.duplicateVerification,
    duplicateTemplate = existing?.duplicateTemplate,
    duplicateTemplateDigest = existing?.duplicateTemplateDigest,
    duplicatePolicyRevision = existing?.duplicatePolicyRevision,
```

and in `enter`, inside the `.copy(` block after `ssccIssuerPrefix = bundle.sscc?.issuerPrefix,` add:

```kotlin
                        duplicateVerification = bundle.shift.validationPrint.verification,
                        duplicateTemplate = bundle.shift.validationPrint.snapshot?.spec?.toString(),
                        duplicateTemplateDigest = bundle.shift.validationPrint.snapshot?.digest,
                        duplicatePolicyRevision = bundle.shift.validationPrint.policyRevision,
```

The `toEntity` lines are not optional and not symmetry for its own sake: a shift-list refresh rebuilds the row from the list, which carries none of this. Without them a refresh mid-shift would silently strip the policy and every later unit would refuse to print with nothing on screen connecting it to a list refresh. That exact defect cost the aggregation slice a manual walk-through to find.

- [ ] **Step 11: Add the repository regression test**

In `app/src/test/kotlin/app/markiro/handheld/feature/shift/ShiftRepositoryTest.kt`, find the existing test that asserts a list refresh preserves `ssccIssuerPrefix` and `boxLabelTemplate`. Extend it to assert the same for `duplicateVerification`, `duplicateTemplate`, `duplicateTemplateDigest` and `duplicatePolicyRevision`, seeding them on the cached row first.

Verify the assertion has teeth: comment out the four `toEntity` lines from Step 10, run the test, confirm it fails with `expected:<required> but was:<null>`, then restore them.

- [ ] **Step 12: Run the affected suites**

Run: `./gradlew --no-daemon testDebugUnitTest --tests '*core.storage.*' --tests '*feature.shift.*'`
Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add app/src/main/kotlin/app/markiro/handheld/core/storage app/src/main/kotlin/app/markiro/handheld/core/network/ShiftDtos.kt app/src/main/kotlin/app/markiro/handheld/feature/shift/ShiftRepository.kt app/src/test/kotlin/app/markiro/handheld/core/storage app/src/test/kotlin/app/markiro/handheld/feature/shift/ShiftRepositoryTest.kt
git commit -m "feat(handheld): store duplicate jobs, their events and the shift policy"
```

---

### Task 3: Prepare and send

The scan loop grows a second half: an accepted unit becomes a job in the same transaction, its label is rendered once and sent, and a second unit is refused by name while that job is unresolved.

**Files:**

- Create: `app/src/main/kotlin/app/markiro/handheld/core/duplicate/DuplicateLabel.kt`
- Create: `app/src/main/kotlin/app/markiro/handheld/core/duplicate/DuplicateJobs.kt`
- Create: `app/src/main/kotlin/app/markiro/handheld/core/duplicate/DuplicateModule.kt`
- Test: `app/src/test/kotlin/app/markiro/handheld/core/duplicate/DuplicateJobsTest.kt`

**Interfaces:**

- Consumes: `applyProductLabelEvent`, `ProductLabelEvent`, `ProductLabelProjection`, `parseDuplicateKm`, `duplicatePayloadDigest`, `productLabelBytesDigest`, `AttemptState`, `JobStatus`, `Verification` (Task 1); `ProductLabelJobEntity`, `ProductLabelEventEntity`, the two DAOs (Task 2); `LabelRenderer`, `LabelSpecCodec`, `PrinterLanguage`, `LabelRenderException`, `LabelField` from `core.label`; `PrinterTransport`, `PrinterStatus`, `SendOutcome`, `NotReadyReason` from `core.print`; `boxLabelFields`, `BoxLabelInput`, `PrintReason` from `core.box`; `Iso` from `core.util`.
- Produces:
  - `fun duplicateLabelFields(shift: ShiftEntity, canonicalRaw: String, acceptedAt: String, operatorName: String?): Map<LabelField, String>`
  - `sealed interface DuplicateOutcome { data class Prepared(val jobId: String) : DuplicateOutcome; data class Refused(val reason: String) : DuplicateOutcome; data object NotApplicable : DuplicateOutcome }`
  - `sealed interface DuplicateSend { data object Sent : DuplicateSend; data class Failed(val reason: String) : DuplicateSend; data class Unknown(val cause: String) : DuplicateSend }`
  - `class DuplicateJobs` with
    - `suspend fun preflight(shift: ShiftEntity): String?` — a refusal reason, or null when the shift is ready to print
    - `suspend fun accept(shift: ShiftEntity, canonicalRaw: String, codeHash: String, operatorId: String, operatorName: String?): DuplicateOutcome`
    - `suspend fun send(jobId: String): DuplicateSend`
    - `suspend fun demoteInterrupted()`
    - `suspend fun openJob(shiftId: String): ProductLabelJobEntity?`
  - `object DuplicateReason` with `PRINTER_UNCONFIGURED`, `PRINTER_CHANGED`, `TEMPLATE_MISSING`, `TEMPLATE_INVALID`, `RENDER_FAILED`, `CODE_INCOMPLETE`, `JOB_OUTSTANDING`, plus the transport reasons reused from `PrintReason`

- [ ] **Step 1: Write the failing test**

Create `app/src/test/kotlin/app/markiro/handheld/core/duplicate/DuplicateJobsTest.kt` covering, with an in-memory Room database and a fake `PrinterTransport` (model it on `app/src/test/kotlin/app/markiro/handheld/core/box/BoxPrinterTest.kt`, which already builds one):

```kotlin
    /** The whole slice turns on this: the operator is holding a sticker. */
    @Test
    fun aSecondUnitIsRefusedWhileAJobIsUnresolved()

    /** Caught before the first unit is accepted, not halfway through a shift. */
    @Test
    fun aShiftWithNoSelectedPrinterIsRefusedByPreflight()

    /** The bytes are rendered once and stored; nothing re-renders them. */
    @Test
    fun acceptingAUnitStoresTheBytesAndAPreparedEvent()

    /**
     * The domain refuses a reprint whose bytes, language or dpi differ, so a
     * job prepared on another printer can never be reprinted. Catching it
     * before the send is the only thing that stops a dead end.
     */
    @Test
    fun changingThePrinterBetweenPrepareAndSendFailsBeforeSending()

    @Test
    fun aDeliveredSendRecordsSendingThenSent()

    @Test
    fun aRefusedSendRecordsFailedBeforeSendWithThePrintersOwnReason()

    @Test
    fun anUnknownSendRecordsDeliveryUnknownAndNothingResends()

    /** Resuming would be an automatic resend of a label that may already exist. */
    @Test
    fun aJobLeftInSendingBecomesUnknownWithInterruptedAtStartup()

    /** A code with no crypto tail cannot be reproduced, so it must never reach a label. */
    @Test
    fun aCodeWithoutItsCryptoTailIsRefused()
```

Write each one out fully against the interfaces above before moving on.

- [ ] **Step 2: Run it to verify it fails**

Run: `./gradlew --no-daemon testDebugUnitTest --tests '*DuplicateJobsTest*'`
Expected: FAIL — compilation error, `Unresolved reference: DuplicateJobs`.

- [ ] **Step 3: Write the label fields**

Create `app/src/main/kotlin/app/markiro/handheld/core/duplicate/DuplicateLabel.kt`:

```kotlin
package app.markiro.handheld.core.duplicate

import app.markiro.handheld.core.box.BoxLabelInput
import app.markiro.handheld.core.box.boxLabelFields
import app.markiro.handheld.core.label.LabelField
import app.markiro.handheld.core.storage.ShiftEntity

/**
 * A duplicate's label data.
 *
 * It shares the box label's calendar and naming rules -- same product, same
 * shift, same inclusive expiry -- and differs in exactly three fields: it
 * carries the marking code, it is one item, and it has no SSCC. `acceptedAt`
 * stands where the box label puts `closedAt`, so a reprint tomorrow still
 * prints the day the unit was accepted rather than the day it was reprinted.
 */
fun duplicateLabelFields(
    shift: ShiftEntity,
    canonicalRaw: String,
    acceptedAt: String,
    operatorName: String?,
): Map<LabelField, String> {
    val km = parseDuplicateKm(canonicalRaw)
    val base = boxLabelFields(
        BoxLabelInput(
            sscc = "",
            itemCount = 1,
            productName = shift.productName.orEmpty(),
            productPrintName = shift.productPrintName,
            gtin14 = shift.productGtin14.orEmpty(),
            egaisCode = shift.egaisCode,
            shelfLifeDays = shift.shelfLifeDays,
            operatorName = operatorName,
            counterpartyName = shift.counterpartyName,
            closedAt = acceptedAt,
            productionDate = shift.productionDate,
            shiftNumber = shift.number,
        ),
    )
    return base + mapOf(
        LabelField.KM_CODE to km.canonicalRaw,
        LabelField.QTY to "1",
        LabelField.SSCC to "",
    )
}
```

- [ ] **Step 4: Write the engine**

Create `app/src/main/kotlin/app/markiro/handheld/core/duplicate/DuplicateJobs.kt` implementing the interfaces listed above. The rules it must encode, each of which has a test in Step 1:

- `preflight` returns `PRINTER_UNCONFIGURED` with no selected printer, `TEMPLATE_MISSING` with no `duplicateTemplate`, `TEMPLATE_INVALID` when `LabelSpecCodec.parse` throws, and null otherwise.
- `accept` runs inside `db.withTransaction`, guarded by a `Mutex` as `CloseBox` is, and: refuses with `JOB_OUTSTANDING` when `openJob(shiftId)` is non-null; refuses with `CODE_INCOMPLETE` when `parseDuplicateKm` throws; otherwise renders the bytes through `LabelRenderer`, writes the job row and the `prepared` event, and returns `Prepared(jobId)`.
- Ids are `java.util.UUID.randomUUID().toString()`, lowercase, because the server's schema is `z.uuid().toLowerCase()`.
- `send` re-reads the job, compares the selected printer's `language` and `dpi` against the job's, and on a difference records `failed_before_send` with `printer_changed` **without sending**. Otherwise it asks `transport.status(printer)` first — so a refusal carries the printer's own reason rather than a generic timeout — then records `sending`, sends, and records `sent`, `failed_before_send` or `delivery_unknown` from the outcome.
- Every event is written through a single private `append(job, event)` that calls `applyProductLabelEvent` first and persists the projection onto the job row in the same transaction. A `ProductLabelTransitionException` here is a programming error, not an operator one: let it propagate.
- `demoteInterrupted` turns every `attemptState = 'sending'` row into `delivery_unknown` with `interrupted`.

- [ ] **Step 5: Register it with Hilt**

Create `app/src/main/kotlin/app/markiro/handheld/core/duplicate/DuplicateModule.kt`, modelled on `app/src/main/kotlin/app/markiro/handheld/core/box/BoxModule.kt`, providing `DuplicateJobs` as a `@Singleton`.

- [ ] **Step 6: Run the test to verify it passes**

Run: `./gradlew --no-daemon testDebugUnitTest --tests '*DuplicateJobsTest*'`
Expected: PASS, 9 tests.

- [ ] **Step 7: Commit**

```bash
git add app/src/main/kotlin/app/markiro/handheld/core/duplicate app/src/test/kotlin/app/markiro/handheld/core/duplicate/DuplicateJobsTest.kt
git commit -m "feat(handheld): prepare and send a unit's duplicate, one job at a time"
```

---

### Task 4: Verify and reprint

The other half of a job's life: the scan that proves the sticker is readable, and the reprint that replays the same bytes when it is not.

**Files:**

- Modify: `app/src/main/kotlin/app/markiro/handheld/core/duplicate/DuplicateJobs.kt`
- Test: `app/src/test/kotlin/app/markiro/handheld/core/duplicate/DuplicateVerifyTest.kt`

**Interfaces:**

- Consumes: everything Task 3 produces.
- Produces, added to `DuplicateJobs`:
  - `suspend fun verify(jobId: String, scannedRaw: String): DuplicateMatch` — records `verified` on a match and `verification_rejected` with `mismatch` or `invalid` otherwise, and returns what it recorded
  - `suspend fun reprint(jobId: String, reason: String): DuplicateOutcome` — records a second `prepared` with the same bytes, language and dpi, a new `attemptId` and `attemptNo + 1`
  - `object ReprintReason { const val NOT_PRINTED = "not_printed"; const val DAMAGED = "damaged"; const val LOST = "lost" }`

- [ ] **Step 1: Write the failing test**

Create `app/src/test/kotlin/app/markiro/handheld/core/duplicate/DuplicateVerifyTest.kt` with these cases, each written out in full:

```kotlin
    @Test
    fun scanningTheSameStickerCompletesTheJob()

    /** A different unit of the same product shares the identity hash and must still be refused. */
    @Test
    fun scanningADifferentUnitIsAMismatchAndTheJobStaysOutstanding()

    @Test
    fun scanningSomethingUnreadableIsInvalidAndTheJobStaysOutstanding()

    /**
     * The domain accepts `verified` out of `delivery_unknown` even when the
     * policy is `none`. This is the only verification such a shift ever does,
     * and it is how "did a label come out?" gets answered without a reprint.
     */
    @Test
    fun anUnknownDeliveryIsResolvedByAScanUnderNoVerification()

    @Test
    fun aReprintReplaysTheSameBytesUnderANewAttempt()

    @Test
    fun aReprintCarriesItsReasonAndTheFirstAttemptCarriesNone()

    @Test
    fun aReprintIsRefusedWhileAnAttemptIsStillInFlight()

    /** The attempt is what freezes, not the job. */
    @Test
    fun aVerifiedAttemptTakesNoFurtherEventOfItsOwn()

    /** A verified label can be damaged later; under `required` the new copy must be scanned back. */
    @Test
    fun aCompletedJobTakesAReprintWhichDropsBackToPendingVerification()

    /** Retention dropped the bytes at shift close; there is nothing to replay. */
    @Test
    fun aReprintAfterTheBytesAreGoneIsRefusedRatherThanReRendered()
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./gradlew --no-daemon testDebugUnitTest --tests '*DuplicateVerifyTest*'`
Expected: FAIL — compilation error, `Unresolved reference: verify`.

- [ ] **Step 3: Implement `verify` and `reprint`**

`verify` calls `compareDuplicateKm(job.canonicalRaw, scannedRaw)` and appends `verified` with `scannedPayloadDigest = duplicatePayloadDigest(scannedRaw)` on `MATCH`, or `verification_rejected` with `reason = "mismatch" | "invalid"` otherwise.

`reprint` refuses with `RENDER_FAILED` when `bytesBase64` is null — the bytes are gone and re-rendering them would print a symbol whose digest no longer matches the one the server holds — and otherwise appends a `prepared` carrying the job's existing `bytesDigest`, `language` and `dpi`, a fresh `attemptId` and `attemptNo + 1`. It does not send; the caller sends, exactly as the first attempt does.

- [ ] **Step 4: Run the test to verify it passes**

Run: `./gradlew --no-daemon testDebugUnitTest --tests '*DuplicateVerifyTest*'`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/kotlin/app/markiro/handheld/core/duplicate/DuplicateJobs.kt app/src/test/kotlin/app/markiro/handheld/core/duplicate/DuplicateVerifyTest.kt
git commit -m "feat(handheld): verify a printed duplicate and reprint the same bytes"
```

---

### Task 5: The fourth batch channel

Events reach the server through the same `POST /station/scans` batch as scans and box closures, under the same pinning rule, and its receipt is applied per event.

**Files:**

- Modify: `app/src/main/kotlin/app/markiro/handheld/core/network/SyncDtos.kt:47`
- Modify: `app/src/main/kotlin/app/markiro/handheld/core/storage/MetaStore.kt`
- Modify: `app/src/main/kotlin/app/markiro/handheld/core/sync/SyncEngine.kt`
- Modify: `app/src/main/kotlin/app/markiro/handheld/feature/shift/ShiftCloser.kt` (retention hook)
- Test: `app/src/test/kotlin/app/markiro/handheld/core/sync/DuplicateSyncTest.kt`

**Interfaces:**

- Consumes: `ProductLabelEventDao`, `ProductLabelJobDao` (Task 2).
- Produces:
  - `SyncBatchRequest` gains `productLabelEvents: List<JsonElement> = emptyList()`
  - `MetaStore.SYNC_PENDING_LABEL_COUNT = "sync_pending_label_count"`
  - `SyncEngine.MAX_PRODUCT_LABEL_EVENTS = 100`

- [ ] **Step 1: Write the failing test**

Create `app/src/test/kotlin/app/markiro/handheld/core/sync/DuplicateSyncTest.kt`, modelled on the box-closure cases already in `app/src/test/kotlin/app/markiro/handheld/core/sync/SyncEngineTest.kt`:

```kotlin
    @Test
    fun eventsRideTheSameBatchAsScansAndBoxes()

    /** The server refuses a gap, so the drain may not reorder a job's events. */
    @Test
    fun aJobsEventsAreSentInSequenceOrder()

    @Test
    fun aBatchIsCappedAtOneHundredEvents()

    /**
     * A batch in flight carries the event set it already chose. Growing one whose
     * id is fixed is how a record gets answered `alreadyApplied` and lost -- the
     * same rule box closures already follow.
     */
    @Test
    fun aPinnedBatchDoesNotPickUpEventsRecordedSince()

    @Test
    fun acceptedEventIdsAreAcknowledgedAndLeaveTheQueue()

    /** Quarantine is not delivery: the event leaves the queue but keeps its code. */
    @Test
    fun aQuarantinedEventIsNotTreatedAsAccepted()

    @Test
    fun theSyncIndicatorCountsUnsentEvents()
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./gradlew --no-daemon testDebugUnitTest --tests '*DuplicateSyncTest*'`
Expected: FAIL — compilation error, `Unresolved reference: productLabelEvents`.

- [ ] **Step 3: Extend the request**

In `app/src/main/kotlin/app/markiro/handheld/core/network/SyncDtos.kt`, change `SyncBatchRequest` to:

```kotlin
@Serializable
data class SyncBatchRequest(
    val batchId: String,
    val items: List<ScanItemDto>,
    val boxes: List<BoxClosureDto> = emptyList(),
    /**
     * Product-label events, sent as the stored JSON rather than re-encoded: the
     * server's schema is strict per event kind, and a field this client added by
     * re-serialising a nullable-field class would fail the whole batch.
     */
    val productLabelEvents: List<JsonElement> = emptyList(),
)
```

and add `import kotlinx.serialization.json.JsonElement` at the top.

- [ ] **Step 4: Extend the drain**

In `app/src/main/kotlin/app/markiro/handheld/core/storage/MetaStore.kt`, add next to `SYNC_PENDING_BOX_COUNT`:

```kotlin
        const val SYNC_PENDING_LABEL_COUNT = "sync_pending_label_count"
```

In `app/src/main/kotlin/app/markiro/handheld/core/sync/SyncEngine.kt`, inside `drainOnce`, mirror the box-closure block exactly:

- read `labelLimit` the same way `boxLimit` is read, from `SYNC_PENDING_LABEL_COUNT` when a ceiling is pinned and `MAX_PRODUCT_LABEL_EVENTS` otherwise;
- read `labelRows = db.productLabelEventDao().unacked(labelLimit)`;
- treat the batch as empty only when `rows`, `boxRows` **and** `labelRows` are all empty;
- fold the event count into the batch id next to `boxSignature`, and persist `SYNC_PENDING_LABEL_COUNT` with the other pinned keys;
- parse `productLabelReceipt` out of the response and, inside the acknowledging transaction, call `markAcked(receipt.acceptedEventIds, at)` and `markQuarantined(id, code, at)` per quarantined record. **Acknowledging every sent event unconditionally is wrong here**, unlike box closures: the server answers per event and may quarantine one.
- remove `SYNC_PENDING_LABEL_COUNT` alongside the other pinned keys in both the success path and `clearPending`.

Add to the `state` combine so the indicator counts them: `pending = scans + boxes + labels`.

- [ ] **Step 5: Hook retention to shift close**

In `app/src/main/kotlin/app/markiro/handheld/feature/shift/ShiftCloser.kt`, after the close event is recorded, call:

```kotlin
        db.productLabelJobDao().dropBytesForShift(shiftId)
        db.productLabelJobDao().purgeSettled(shiftId)
```

Closing a shift with an outstanding job warns and closes — the same rule the aggregation slice took for the deferred-label queue. Blocking a shift close on a printer would stop a line over a sticker.

- [ ] **Step 6: Run the test to verify it passes**

Run: `./gradlew --no-daemon testDebugUnitTest --tests '*DuplicateSyncTest*' --tests '*SyncEngineTest*' --tests '*ShiftCloserTest*'`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/src/main/kotlin/app/markiro/handheld/core/network/SyncDtos.kt app/src/main/kotlin/app/markiro/handheld/core/storage/MetaStore.kt app/src/main/kotlin/app/markiro/handheld/core/sync/SyncEngine.kt app/src/main/kotlin/app/markiro/handheld/feature/shift/ShiftCloser.kt app/src/test/kotlin/app/markiro/handheld/core/sync/DuplicateSyncTest.kt
git commit -m "feat(handheld): carry product-label events on the scan batch"
```

---

### Task 6: Screens, and lifting the refusal

The operator-facing half, and the one line that makes the whole thing reachable.

**Files:**

- Create: `app/src/main/kotlin/app/markiro/handheld/feature/work/DuplicateScreens.kt`
- Modify: `app/src/main/kotlin/app/markiro/handheld/feature/work/WorkViewModel.kt`
- Modify: `app/src/main/kotlin/app/markiro/handheld/feature/work/WorkScreen.kt:152`
- Modify: `app/src/main/kotlin/app/markiro/handheld/AppNavigation.kt`
- Modify: `app/src/main/res/values/strings.xml`
- Modify: `app/src/main/res/values-en/strings.xml`
- Modify: `app/src/main/kotlin/app/markiro/handheld/core/network/Dtos.kt:6`
- Modify: `apps/handheld/README.md`
- Modify: `docs/architecture.md`
- Test: `app/src/test/kotlin/app/markiro/handheld/feature/work/DuplicateScreensTest.kt`
- Test: `app/src/test/kotlin/app/markiro/handheld/feature/work/WorkViewModelTest.kt` (add cases)
- Test: `app/src/test/kotlin/app/markiro/handheld/EnglishRenderTest.kt` (add the new screens)

**Interfaces:**

- Consumes: `DuplicateJobs`, `DuplicateOutcome`, `DuplicateSend`, `DuplicateMatch`, `ReprintReason`, `DuplicateReason` (Tasks 3–4).
- Produces:
  - `sealed interface DuplicateStep { data object Idle; data class Printing(val tail: String); data class Failed(val jobId: String, val reason: String); data class Unknown(val jobId: String, val cause: String); data class Rejected(val jobId: String, val reason: String); data class Reprinting(val jobId: String) }`
  - `WorkUi` gains `duplicate: DuplicateUi?` where `data class DuplicateUi(val status: String, val awaitingVerification: Boolean)`

- [ ] **Step 1: Route the scan**

In `WorkViewModel.onScan`, before the existing recorder call, branch on the shift's policy. The routing is the spec's table and must be implemented exactly:

| Open job                          | The scan is              |
| --------------------------------- | ------------------------ |
| none, or the last one `completed` | a new unit               |
| `prepared` or `sending`           | refused — «идёт печать»  |
| `awaiting_verification`           | the verification         |
| `delivery_unknown`                | the verification         |
| `failed_before_send`              | refused — reprint or fix |

A refusal is a verdict on the last-scan zone with its own text and the error signal, never a silently dropped scan: an operator whose unit vanished with no sound and no count has no way to know it needs scanning again.

- [ ] **Step 2: Keep the normal path quiet**

A duplicate prints on **every** unit, so the ordinary path must not take over the screen. In `WorkScreen`, the validation branch currently renders `LastScanZone(state.last, Modifier.weight(0.4f))`; extend that zone to carry the duplicate's progress — «печатаем», then the ordinary «ПРИНЯТО» — and, under `required`, to say that the next trigger pull is a verification. Without that line the operator scans the next product, is told it is the wrong code, and has no idea why.

- [ ] **Step 3: Write the full-screen states**

Create `DuplicateScreens.kt` on the model of `BoxCloseScreens.kt`. Full screen only for `Failed` (with the printer's own reason, via a `duplicateReasonLabel` mapping in the same shape as `printReasonLabel`), `Unknown`, and `Rejected`. The `Unknown` screen leads with the scan, not the reprint — «Посмотрите на принтер. Если этикетка вышла, отсканируйте её» — with reprint underneath, because under a `none` policy that is the only place a verification scan is ever offered and the screen has to say what the trigger pull will do.

Reprint is a list of the three reasons: «Не напечаталась», «Испорчена», «Потеряна».

**No new signal.** A rejected verification means to the operator what an error means — that scan did not count, do it again — so it uses `SignalKind.ERROR`.

- [ ] **Step 4: Write the screen tests**

Create `DuplicateScreensTest.kt` asserting each state renders its own text and its buttons, in both languages, and add the new composables to `EnglishRenderTest`.

Add to `WorkViewModelTest`: a second unit scanned while a job is unresolved is refused rather than accepted; a scan in `awaiting_verification` is read as a verification; a scan in `failed_before_send` is refused.

- [ ] **Step 5: Warn on a shift close with an outstanding job**

Task 5 made shift close purge the bytes; the operator still has to be told. In the close confirmation (`app/src/main/kotlin/app/markiro/handheld/feature/shift/CloseScreens.kt`, beside the existing unprinted-label warning), show a line naming how many duplicate jobs are unresolved, and **close anyway** when the operator confirms. This is the same rule the aggregation slice took for the deferred-label queue: blocking a shift close on a printer would stop a line over a sticker.

Add a `CloseScreensTest` case asserting the warning appears with an outstanding job, is absent without one, and never disables the confirm button.

- [ ] **Step 6: Lift the refusal**

In `app/src/main/kotlin/app/markiro/handheld/core/network/Dtos.kt`, change:

```kotlin
/** `station-recovery-v1` makes the server return `denied[]` on scan batches; `validation-dm-duplicate-v1` enables duplicate printing. */
const val HANDHELD_CAPABILITIES = "handheld-v1,subscription-state-v1,station-recovery-v1,validation-dm-duplicate-v1"
```

Then delete the `shifts_update_required_title` / `shifts_update_required_text` handling only if nothing else can produce `STATION_UPDATE_REQUIRED`; check `ShiftRepository.enter` first. If a future protocol could still raise it, keep `EnterResult.UpdateRequired` and reword the strings to a generic "this shift needs a newer app", in both languages.

- [ ] **Step 7: Run the full gates**

Run: `./gradlew --no-daemon testDebugUnitTest lintDebug assembleDebug`
Expected: BUILD SUCCESSFUL.

- [ ] **Step 8: Document it**

In `apps/handheld/README.md`, add a "Duplicate printing" section covering: which shifts it applies to, one job at a time, that the bytes are replayed and never re-rendered, that an unknown delivery is resolved by scanning the sticker under either policy, the two-step retention, and the manual walk-through recipe (which shift to create in the cabinet, and that a printed symbol's readability is not proven by any test here).

In `docs/architecture.md`, record that the handheld now advertises `validation-dm-duplicate-v1` and that its duplicate jobs carry no credential ownership because revocation wipes the database.

- [ ] **Step 9: Commit**

```bash
git add app/src/main/kotlin/app/markiro/handheld/feature/work app/src/main/kotlin/app/markiro/handheld/AppNavigation.kt app/src/main/res app/src/main/kotlin/app/markiro/handheld/core/network/Dtos.kt app/src/test/kotlin/app/markiro/handheld/feature/work app/src/test/kotlin/app/markiro/handheld/EnglishRenderTest.kt README.md
cd ../.. && git add docs/architecture.md && git commit -m "feat(handheld): print, verify and reprint a duplicate Data Matrix per unit" && cd apps/handheld
```

---

## The manual walk-through is not optional

The printing slice found four defects on an emulator and the aggregation slice six; in both, the worst were in the seam between screens and states, and none of them failed a unit test. This slice has more states per unit than the box ever had.

Before the pull request, run the app against a real API and a real (or emulated) printer and confirm, in order:

1. A validation shift with `duplicate_dm` and `verification: none` can be **entered at all** — that is the refusal this slice lifts.
2. A unit scan prints a label without taking over the screen.
3. A second unit scanned before the first settles is refused with words, not silence.
4. Under `required`, the main zone says the next pull is a verification; scanning the sticker completes the unit; scanning a different unit is rejected and the job stays outstanding.
5. Killing the app mid-print leaves the job as unknown on restart, offering the scan first and the reprint second.
6. A reprint prints and carries its reason.
7. Closing the shift with an outstanding job warns, closes, and the events still sync.
8. Re-entering the shift after a list refresh still prints — the `toEntity` trap from Task 2, Step 10.

## What this plan cannot prove

State these plainly in the pull request.

- **That a printed duplicate scans.** Verification checks exactly this at runtime, but an emulator's stand-in scan exercises the state machine, not print quality. Only a real printer and a real scanner settle it.
- **Throughput.** A print per unit, and under `required` a second trigger pull per unit. Whether that pace suits a real line is not something this slice can establish.
- **Bluetooth on hardware.** Still unverifiable on an emulator.
- **The retention horizon.** Purging at shift close is the rule; whether a long shift on a small device fills up before that is a question for the first real deployment.
