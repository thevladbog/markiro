import { ServiceUnavailableException } from "@nestjs/common";

export class UsReadinessScopeTooLargeException extends ServiceUnavailableException {
  constructor() {
    super({ code: "us_readiness_scope_too_large" });
  }
}
