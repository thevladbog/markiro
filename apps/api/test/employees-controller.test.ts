import "reflect-metadata";
import { BadRequestException, ParseUUIDPipe } from "@nestjs/common";
import { ROUTE_ARGS_METADATA } from "@nestjs/common/constants";
import { describe, expect, it } from "vitest";
import { EmployeesController } from "../src/modules/employees/employees.controller";

interface RouteArgumentMetadata {
  index: number;
  data?: string;
  pipes: unknown[];
}

function idPipes(methodName: string): unknown[] {
  const metadata = Reflect.getMetadata(
    ROUTE_ARGS_METADATA,
    EmployeesController,
    methodName,
  ) as Record<string, RouteArgumentMetadata>;
  const idArgument = Object.values(metadata).find(
    (argument) => argument.index === 1 && argument.data === "id",
  );
  if (!idArgument) throw new Error(`Expected ${methodName} id route argument metadata`);
  return idArgument.pipes;
}

describe("EmployeesController pickup policy id boundary", () => {
  it("rejects a malformed UUID before calling the pickup policy service", async () => {
    const [pipe] = idPipes("updatePickupPolicy");

    expect(pipe).toBeInstanceOf(ParseUUIDPipe);
    await expect(
      (pipe as ParseUUIDPipe).transform("not-a-uuid", {
        type: "param",
        metatype: String,
        data: "id",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each(["updateEmployee", "archiveEmployee", "issueBadge", "revokeBadge"])(
    "does not alter the existing %s id contract",
    (methodName) => {
      expect(idPipes(methodName)).toEqual([]);
    },
  );
});
