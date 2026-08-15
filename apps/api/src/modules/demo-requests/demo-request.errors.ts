import { HttpException, HttpStatus } from "@nestjs/common";

export function captchaInvalidError(): HttpException {
  return new HttpException({ code: "captcha_invalid" }, HttpStatus.BAD_REQUEST);
}

export function captchaUnavailableError(): HttpException {
  return new HttpException({ code: "captcha_unavailable" }, HttpStatus.SERVICE_UNAVAILABLE);
}

export function rateLimitedError(): HttpException {
  return new HttpException({ code: "rate_limited" }, HttpStatus.TOO_MANY_REQUESTS);
}

export function invalidRequestError(): HttpException {
  return new HttpException({ code: "invalid_request" }, HttpStatus.BAD_REQUEST);
}

export function submissionDisabledError(): HttpException {
  return new HttpException({ code: "submission_disabled" }, HttpStatus.NOT_FOUND);
}

export function submissionUnavailableError(): HttpException {
  return new HttpException({ code: "submission_unavailable" }, HttpStatus.SERVICE_UNAVAILABLE);
}
