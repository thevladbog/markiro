import { describe, expect, it } from "vitest";

import {
  platformActivationCompleteRequestSchema,
  platformActivationSuccessSchema,
  platformAuditContracts,
  platformAuditResponseSchema,
  platformCapabilitiesForRole,
  platformMutationAcknowledgementSchema,
  platformPrincipalSchema,
  platformTeamContracts,
  platformTeamListResponseSchema,
} from "../src/index.js";

const ADMIN_CAPABILITIES = [
  "tenants.read",
  "tenants.write",
  "catalog.read",
  "catalog.write",
  "billing.read",
  "billing.write",
  "platformTeam.write",
  "audit.read",
  "diagnostics.read",
] as const;

describe("platform identity contracts", () => {
  it("accepts every platform role with only its exact capability vocabulary", () => {
    expect(platformCapabilitiesForRole).toEqual({
      platform_admin: ADMIN_CAPABILITIES,
      support: ["tenants.read", "tenants.write", "catalog.read", "audit.read", "diagnostics.read"],
      accountant: [
        "tenants.read",
        "catalog.read",
        "catalog.write",
        "billing.read",
        "billing.write",
        "audit.read",
      ],
    });

    expect(
      platformPrincipalSchema.parse({
        userId: "platform-user-1",
        role: "platform_admin",
        capabilities: ADMIN_CAPABILITIES,
        twoFactorReady: true,
      }),
    ).toEqual({
      userId: "platform-user-1",
      role: "platform_admin",
      capabilities: ADMIN_CAPABILITIES,
      twoFactorReady: true,
    });
    expect(
      platformPrincipalSchema.safeParse({
        userId: "platform-user-2",
        role: "support",
        capabilities: ["billing.write"],
        twoFactorReady: true,
      }).success,
    ).toBe(false);
    expect(
      platformPrincipalSchema.safeParse({
        userId: "platform-user-3",
        role: "owner",
        capabilities: [],
        twoFactorReady: false,
      }).success,
    ).toBe(false);
  });

  it("normalizes team timestamps and validates every team success shape", () => {
    expect(
      platformTeamListResponseSchema.parse([
        {
          id: "platform-user-2",
          name: "Support Operator",
          email: "support@example.invalid",
          role: "support",
          status: "invited",
          twoFactorReady: false,
          createdAt: new Date("2026-08-11T18:08:42.158Z"),
        },
      ]),
    ).toEqual([
      {
        id: "platform-user-2",
        name: "Support Operator",
        email: "support@example.invalid",
        role: "support",
        status: "invited",
        twoFactorReady: false,
        createdAt: "2026-08-11T18:08:42.158Z",
      },
    ]);
    expect(
      platformTeamContracts.invite.response.parse({
        userId: "platform-user-2",
        deliveryId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toEqual({
      userId: "platform-user-2",
      deliveryId: "11111111-1111-4111-8111-111111111111",
    });
    expect(platformMutationAcknowledgementSchema.parse({ status: true })).toEqual({ status: true });
    expect(
      platformTeamListResponseSchema.safeParse([
        {
          id: "platform-user-2",
          name: "Support Operator",
          email: "support@example.invalid",
          role: "support",
          twoFactorReady: false,
          createdAt: "2026-08-11T18:08:42.158Z",
        },
      ]).success,
    ).toBe(false);
  });

  it("keeps team route params bounded and rejects path separators", () => {
    expect(platformTeamContracts.changeRole.params.parse({ id: "platform user?#%" })).toEqual({
      id: "platform user?#%",
    });
    expect(platformTeamContracts.suspend.params.safeParse({ id: "x".repeat(129) }).success).toBe(
      false,
    );
    expect(
      platformTeamContracts.renewActivation.params.safeParse({ id: "platform/user" }).success,
    ).toBe(false);
  });

  it("validates public activation input without exposing credentials in the success shape", () => {
    const request = platformActivationCompleteRequestSchema.parse({
      token: "activation-token-with-enough-entropy",
      password: "correct horse battery staple",
    });
    expect(Object.keys(request).sort()).toEqual(["password", "token"]);
    expect(platformActivationSuccessSchema.parse({ twoFactorEnrollmentRequired: true })).toEqual({
      twoFactorEnrollmentRequired: true,
    });
    expect(
      platformActivationSuccessSchema.safeParse({
        twoFactorEnrollmentRequired: true,
        token: request.token,
      }).success,
    ).toBe(false);
  });

  it("normalizes audit pagination with nullable metadata fields", () => {
    const query = platformAuditContracts.list.query.parse({
      tenantId: "legacy_better_auth_org",
      from: "2026-08-11T00:00:00.000Z",
      to: "2026-08-12T00:00:00.000Z",
      limit: "2",
      offset: "4",
    });
    expect(query).toMatchObject({
      tenantId: "legacy_better_auth_org",
      limit: 2,
      offset: 4,
    });
    expect(query.from).toEqual(new Date("2026-08-11T00:00:00.000Z"));
    expect(query.to).toEqual(new Date("2026-08-12T00:00:00.000Z"));

    expect(
      platformAuditResponseSchema.parse({
        items: [
          {
            id: "21111111-1111-4111-8111-111111111111",
            actorPlatformUserId: null,
            actorRole: null,
            action: "platform.activation.denied",
            outcome: "denied",
            tenantId: null,
            targetType: "platform_user",
            targetId: null,
            reason: "activation_unavailable",
            before: null,
            after: null,
            requestId: null,
            createdAt: new Date("2026-08-11T18:08:42.158Z"),
          },
        ],
        nextOffset: 6,
      }),
    ).toEqual({
      items: [
        {
          id: "21111111-1111-4111-8111-111111111111",
          actorPlatformUserId: null,
          actorRole: null,
          action: "platform.activation.denied",
          outcome: "denied",
          tenantId: null,
          targetType: "platform_user",
          targetId: null,
          reason: "activation_unavailable",
          before: null,
          after: null,
          requestId: null,
          createdAt: "2026-08-11T18:08:42.158Z",
        },
      ],
      nextOffset: 6,
    });
    expect(
      platformAuditResponseSchema.safeParse({
        items: [{ action: "platform.team.invited", outcome: "success" }],
        nextOffset: null,
      }).success,
    ).toBe(false);
    expect(platformAuditResponseSchema.parse({ items: [], nextOffset: 10_100 }).nextOffset).toBe(
      10_100,
    );
  });
});
