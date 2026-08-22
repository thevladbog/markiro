import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PlatformTeamController } from "../src/platform-auth/platform-team.controller.js";
import { PlatformTeamService } from "../src/platform-auth/platform-team.service.js";
import { listenOnLoopback } from "./support/listen-loopback.js";

describe("platform team route params", () => {
  let app: INestApplication;
  const team = {
    changeRole: vi.fn(),
    suspend: vi.fn(),
    renewActivation: vi.fn(),
    recoverTwoFactor: vi.fn(),
  };

  beforeAll(async () => {
    const ref = await Test.createTestingModule({
      controllers: [PlatformTeamController],
      providers: [{ provide: PlatformTeamService, useValue: team }],
    }).compile();
    app = ref.createNestApplication();
    await app.init();
    await listenOnLoopback(app);
  });

  afterAll(() => app.close());

  it.each([
    ["PATCH", `/platform/team/${"x".repeat(129)}/role`, { role: "support" }],
    ["POST", `/platform/team/${"x".repeat(129)}/suspend`, undefined],
    ["POST", "/platform/team/platform%2Fuser/activation/renew", undefined],
    ["POST", "/platform/team/platform%2Fuser/2fa/recover", undefined],
  ] as const)(
    "returns 400 for invalid %s %s before calling the service",
    async (method, path, body) => {
      const pending = request(app.getHttpServer())[method === "PATCH" ? "patch" : "post"](path);
      if (body) pending.send(body);
      await pending.expect(400);

      expect(team.changeRole).not.toHaveBeenCalled();
      expect(team.suspend).not.toHaveBeenCalled();
      expect(team.renewActivation).not.toHaveBeenCalled();
      expect(team.recoverTwoFactor).not.toHaveBeenCalled();
    },
  );
});
