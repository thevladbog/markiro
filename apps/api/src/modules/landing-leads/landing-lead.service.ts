import { CURRENT_DEMO_CONSENT_ID } from "@markiro/legal-documents";
import type { DemoRequestCaptchaService } from "../demo-requests/demo-request-captcha.service";
import {
  invalidRequestError,
  submissionDisabledError,
  submissionUnavailableError,
} from "../demo-requests/demo-request.errors";
import type { DemoRequestRateLimiter } from "../demo-requests/demo-request-rate-limiter";
import type { LandingLeadDto } from "./landing-lead.schema";

type Limiter = Pick<DemoRequestRateLimiter, "assertAllowed">;
type Captcha = Pick<DemoRequestCaptchaService, "assertHuman">;
interface Repository {
  accept(input: LandingLeadDto): Promise<unknown>;
}

/**
 * The public landing form: the same order of defenses as `/api/demo-requests` — switch,
 * rate limit, honeypot, published consent, SmartCaptcha — before anything is stored.
 */
export class LandingLeadService {
  constructor(
    private readonly options: { enabled: boolean },
    private readonly limiter: Limiter,
    private readonly captcha: Captcha,
    private readonly repository: Repository,
  ) {}

  async submit(
    input: LandingLeadDto,
    source: string,
  ): Promise<{ accepted: true; requestId: string }> {
    if (!this.options.enabled) throw submissionDisabledError();
    this.limiter.assertAllowed(source);
    if (input.website !== "") throw invalidRequestError();
    if (input.consentVersion !== CURRENT_DEMO_CONSENT_ID) throw invalidRequestError();

    await this.captcha.assertHuman(input.captchaToken, source);
    try {
      await this.repository.accept(input);
    } catch {
      throw submissionUnavailableError();
    }
    return { accepted: true, requestId: input.requestId };
  }
}
