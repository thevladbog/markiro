import { Injectable } from "@nestjs/common";
import { CURRENT_DEMO_CONSENT_ID } from "@markiro/legal-documents";
import type { DemoRequestCaptchaService } from "./demo-request-captcha.service";
import {
  invalidRequestError,
  submissionDisabledError,
  submissionUnavailableError,
} from "./demo-request.errors";
import type { DemoRequestRateLimiter } from "./demo-request-rate-limiter";
import type { DemoRequestDto } from "./demo-request.schema";

export interface DemoRequestServiceOptions {
  enabled: boolean;
}

type Limiter = Pick<DemoRequestRateLimiter, "assertAllowed">;
type Captcha = Pick<DemoRequestCaptchaService, "assertHuman">;
interface Repository {
  accept(input: DemoRequestDto): Promise<unknown>;
}

@Injectable()
export class DemoRequestService {
  constructor(
    private readonly options: DemoRequestServiceOptions,
    private readonly limiter: Limiter,
    private readonly captcha: Captcha,
    private readonly repository: Repository,
  ) {}

  async submit(
    input: DemoRequestDto,
    source: string,
  ): Promise<{ accepted: true; requestId: string }> {
    if (!this.options.enabled) throw submissionDisabledError();

    this.limiter.assertAllowed(source);
    if (input.website !== "") throw invalidRequestError();
    if (input.consentVersion !== CURRENT_DEMO_CONSENT_ID) {
      throw invalidRequestError();
    }

    await this.captcha.assertHuman(input.captchaToken, source);
    try {
      await this.repository.accept(input);
    } catch {
      throw submissionUnavailableError();
    }
    return { accepted: true, requestId: input.requestId };
  }
}
