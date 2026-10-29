import { CURRENT_DEMO_CONSENT_ID } from "@markiro/legal-documents";
import {
  invalidRequestError,
  submissionDisabledError,
  submissionUnavailableError,
} from "../demo-requests/demo-request.errors";
import type { LandingLeadDto } from "./landing-lead.schema";

interface Limiter {
  assertAllowed(source: string): void | Promise<void>;
}
interface Repository {
  accept(input: LandingLeadDto): Promise<unknown>;
}

/**
 * The public landing form: the same order of defenses as `/api/demo-requests` — switch,
 * rate limit, honeypot, published consent — before anything is stored.
 */
export class LandingLeadService {
  constructor(
    private readonly options: { enabled: boolean },
    private readonly limiter: Limiter,
    private readonly repository: Repository,
  ) {}

  /** Persist admission before storing a lead; rejection never reaches the mail outbox. */
  async submit(
    input: LandingLeadDto,
    source: string,
  ): Promise<{ accepted: true; requestId: string }> {
    if (!this.options.enabled) throw submissionDisabledError();
    await this.limiter.assertAllowed(source);
    if (input.website !== "") throw invalidRequestError();
    if (input.consentVersion !== CURRENT_DEMO_CONSENT_ID) throw invalidRequestError();

    try {
      await this.repository.accept(input);
    } catch {
      throw submissionUnavailableError();
    }
    return { accepted: true, requestId: input.requestId };
  }
}
