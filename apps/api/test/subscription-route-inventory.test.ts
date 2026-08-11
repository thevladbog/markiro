import type { Type } from "@nestjs/common";
import { RequestMethod } from "@nestjs/common";
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { ModulesContainer, Reflector } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { setupAuth } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { setupPlatformAuth } from "../src/platform-auth/platform-auth.setup";
import { PLATFORM_ACCESS_POLICY } from "../src/platform-auth/platform-access-policy";
import { SubscriptionAccessGuard } from "../src/subscriptions/subscription-access.guard";
import {
  ROUTE_SUBSCRIPTION_ACCESS_POLICY,
  type SubscriptionAccessPolicy,
} from "../src/subscriptions/subscription-access-policy";

type RegisteredRoute = {
  controller: Type<unknown>;
  handler: (...args: never[]) => unknown;
  handlerName: string;
  method: RequestMethod;
  path: string;
};

const UNSAFE_METHODS = new Set([
  RequestMethod.POST,
  RequestMethod.PUT,
  RequestMethod.PATCH,
  RequestMethod.DELETE,
]);

// Every entry is an intentional trust-domain exception to the cabinet/station/kiosk
// subscription guard. The equality assertion below makes stale exemptions fail too.
type RouteExemption = {
  reason: string;
  requiredGuards?: readonly string[];
  platformPolicy?: true;
};

const platform = (reason: string): RouteExemption => ({ reason, platformPolicy: true });
const profile: RouteExemption = {
  reason: "user security/profile continuity remains available in read-only mode",
  requiredGuards: ["ProfileSessionGuard"],
};

const EXEMPTIONS: Readonly<Record<string, RouteExemption>> = {
  "ProfileController.deleteAvatar": profile,
  "ProfileController.updateProfile": profile,
  "ProfileController.uploadAvatar": profile,
  "ExchangeController.get": {
    reason:
      "conditional CommerceML import is enforced by EntitlementsService after authoritative session resolution; query/export/success remain available",
  },
  "ExchangeController.post": {
    reason:
      "CommerceML transport upload and export-success acknowledgement preserve recovery continuity",
  },
  "InvitationsController.accept": {
    reason: "public invitation token/session lifecycle is an authentication and security flow",
  },
  "InvitationsController.register": {
    reason: "public invitation token registration is an authentication and security flow",
  },
  "InvitationsController.reject": {
    reason: "public invitation token/session lifecycle is an authentication and security flow",
  },
  "KioskPairController.pair": {
    reason:
      "unpaired kiosk has no device identity; PairingService resolves the authoritative tenant and enforces write access",
  },
  "StationPairController.pair": {
    reason:
      "unpaired station has no device identity; StationPairingService resolves the authoritative tenant and enforces write/quota access",
  },
  "TenantOwnerActivationController.complete": {
    reason: "single-use tenant-owner activation token is a public authentication lifecycle flow",
  },
  "TenantOwnerActivationController.status": {
    reason:
      "single-use tenant-owner activation token status is a public authentication lifecycle flow",
  },
  "PlatformActivationController.complete": platform(
    "public platform activation token is verified by the global platform trust-domain guard",
  ),
  "PlatformCatalogController.archive": platform(
    "platform catalog mutation uses the isolated platform principal and capability policy",
  ),
  "PlatformCatalogController.createVersion": platform(
    "platform catalog mutation uses the isolated platform principal and capability policy",
  ),
  "PlatformCatalogController.publish": platform(
    "platform catalog mutation uses the isolated platform principal and capability policy",
  ),
  "PlatformCatalogController.retire": platform(
    "platform catalog mutation uses the isolated platform principal and capability policy",
  ),
  "PlatformCatalogController.updateVersion": platform(
    "platform catalog mutation uses the isolated platform principal and capability policy",
  ),
  "PlatformSettingsController.setDefaultDemo": platform(
    "platform setting mutation uses the isolated platform principal and capability policy",
  ),
  "PlatformTeamController.changeRole": platform(
    "platform team mutation uses the isolated platform principal and capability policy",
  ),
  "PlatformTeamController.invite": platform(
    "platform team mutation uses the isolated platform principal and capability policy",
  ),
  "PlatformTeamController.recoverTwoFactor": platform(
    "platform account recovery uses the isolated platform principal and capability policy",
  ),
  "PlatformTeamController.renewActivation": platform(
    "platform account lifecycle uses the isolated platform principal and capability policy",
  ),
  "PlatformTeamController.suspend": platform(
    "platform account lifecycle uses the isolated platform principal and capability policy",
  ),
  "PlatformTenantsController.assignAddon": platform(
    "subscription lifecycle is administered by the isolated platform trust domain",
  ),
  "PlatformTenantsController.assignPlan": platform(
    "subscription lifecycle is administered by the isolated platform trust domain",
  ),
  "PlatformTenantsController.create": platform(
    "tenant provisioning is administered by the isolated platform trust domain",
  ),
  "PlatformTenantsController.renewActivation": platform(
    "tenant owner lifecycle is administered by the isolated platform trust domain",
  ),
};

const requestMethodName = (method: RequestMethod): string => RequestMethod[method] ?? "UNKNOWN";

function asPaths(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(asPaths);
  if (typeof value === "string") return [value];
  return [""];
}

function joinPath(controllerPath: string, handlerPath: string): string {
  return `/${[controllerPath, handlerPath]
    .flatMap((part) => part.split("/"))
    .filter(Boolean)
    .join("/")}`;
}

function registeredRoutes(container: ModulesContainer): RegisteredRoute[] {
  const routes: RegisteredRoute[] = [];
  for (const module of container.values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as Type<unknown> | undefined;
      if (!controller) continue;
      const prototype = controller.prototype as Record<string, (...args: never[]) => unknown>;
      for (const handlerName of Object.getOwnPropertyNames(prototype)) {
        if (handlerName === "constructor") continue;
        const handler = prototype[handlerName];
        if (!handler) continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (method === undefined) continue;
        const controllerPaths = asPaths(Reflect.getMetadata(PATH_METADATA, controller));
        const handlerPaths = asPaths(Reflect.getMetadata(PATH_METADATA, handler));
        for (const controllerPath of controllerPaths) {
          for (const handlerPath of handlerPaths) {
            routes.push({
              controller,
              handler,
              handlerName,
              method,
              path: joinPath(controllerPath, handlerPath),
            });
          }
        }
      }
    }
  }
  return routes.sort((left, right) => routeKey(left).localeCompare(routeKey(right)));
}

function routeKey(route: RegisteredRoute): string {
  return `${requestMethodName(route.method)} ${route.path} (${route.controller.name}.${route.handlerName})`;
}

function exemptionKey(route: RegisteredRoute): string {
  return `${route.controller.name}.${route.handlerName}`;
}

describe("registered subscription route inventory", () => {
  let ref: TestingModule;
  let routes: RegisteredRoute[];

  beforeAll(async () => {
    const env = loadEnv();
    const auth = setupAuth(env);
    const platform = setupPlatformAuth(env, auth.db);
    ref = await Test.createTestingModule({
      imports: [
        AppModule.forRoot({
          ...auth,
          ...platform,
          databaseUrl: env.DATABASE_URL,
          env,
        }),
      ],
    }).compile();
    routes = registeredRoutes(ref.get(ModulesContainer));
  });

  afterAll(async () => {
    await ref?.close();
  });

  it("classifies every customer route and pins its exact trust-chain guard order", () => {
    const reflector = new Reflector();
    const inspected = routes.filter((route) => {
      const guards = [
        ...((Reflect.getMetadata(GUARDS_METADATA, route.controller) ?? []) as Type[]),
        ...((Reflect.getMetadata(GUARDS_METADATA, route.handler) ?? []) as Type[]),
      ];
      return (
        guards.includes(SubscriptionAccessGuard) ||
        UNSAFE_METHODS.has(route.method) ||
        (route.controller.name === "ExchangeController" && route.handlerName === "get")
      );
    });
    const encounteredExemptions: string[] = [];
    const unclassified: string[] = [];

    for (const route of inspected) {
      const classGuards = (Reflect.getMetadata(GUARDS_METADATA, route.controller) ?? []) as Type[];
      const methodGuards = (Reflect.getMetadata(GUARDS_METADATA, route.handler) ?? []) as Type[];
      const guards = [...classGuards, ...methodGuards];
      const subscriptionIndex = guards.indexOf(SubscriptionAccessGuard);
      const policy = reflector.getAllAndOverride<SubscriptionAccessPolicy>(
        ROUTE_SUBSCRIPTION_ACCESS_POLICY,
        [route.handler, route.controller],
      );

      if (subscriptionIndex >= 0) {
        expect(policy, `${routeKey(route)} lacks a subscription policy`).toBeDefined();
        if (UNSAFE_METHODS.has(route.method)) {
          const handlerPolicy = Reflect.getMetadata(
            ROUTE_SUBSCRIPTION_ACCESS_POLICY,
            route.handler,
          ) as SubscriptionAccessPolicy | undefined;
          expect(
            handlerPolicy,
            `${routeKey(route)} inherits class read access instead of declaring mutation policy`,
          ).toBeDefined();
          expect(
            handlerPolicy?.mode,
            `${routeKey(route)} explicitly classifies an unsafe method as read-only`,
          ).not.toBe("read");
        }
        const names = guards.map((guard) => guard.name);
        const expected =
          route.controller.name === "KioskController"
            ? ["KioskDeviceGuard", "SubscriptionAccessGuard"]
            : route.controller.name === "StationScansController"
              ? ["TenantGuard", "StationOnlyGuard", "SubscriptionAccessGuard"]
              : ["TenantGuard", "AuthorizationGuard", "SubscriptionAccessGuard"];
        expect(names, `${routeKey(route)} changed its exact identity/authorization chain`).toEqual(
          expected,
        );
        if (route.controller.name === "ShiftsController" && route.handlerName === "getBundle") {
          expect(policy).toEqual({ mode: "recovery", kind: "shift" });
        }
        continue;
      }

      const key = exemptionKey(route);
      encounteredExemptions.push(key);
      const exemption = EXEMPTIONS[key];
      if (!exemption) {
        unclassified.push(routeKey(route));
        continue;
      }
      expect(
        exemption.reason.trim().length,
        `${routeKey(route)} has no documented reason`,
      ).toBeGreaterThan(0);
      if (exemption.requiredGuards) {
        expect(
          guards.map((guard) => guard.name),
          `${routeKey(route)} lost its exemption identity guard`,
        ).toEqual(expect.arrayContaining([...exemption.requiredGuards]));
      }
      if (exemption.platformPolicy) {
        expect(
          reflector.getAllAndOverride(PLATFORM_ACCESS_POLICY, [route.handler, route.controller]),
          `${routeKey(route)} lost its platform authentication/capability policy`,
        ).toBeDefined();
      }
    }

    expect(unclassified, "unclassified registered unsafe routes").toEqual([]);
    expect(encounteredExemptions.sort()).toEqual(Object.keys(EXEMPTIONS).sort());
  });
});
