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
