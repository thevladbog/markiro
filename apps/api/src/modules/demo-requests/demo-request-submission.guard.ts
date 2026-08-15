import { Inject, Injectable, type CanActivate } from "@nestjs/common";
import { submissionDisabledError } from "./demo-request.errors";

export const DEMO_REQUEST_SUBMISSION_ENABLED = Symbol("DEMO_REQUEST_SUBMISSION_ENABLED");

/** Rejects disabled public submissions before Nest evaluates body pipes. */
@Injectable()
export class DemoRequestSubmissionGuard implements CanActivate {
  constructor(@Inject(DEMO_REQUEST_SUBMISSION_ENABLED) private readonly enabled: boolean) {}

  canActivate(): true {
    if (!this.enabled) throw submissionDisabledError();
    return true;
  }
}
