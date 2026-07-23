/**
 * Converts a possibly-undefined react-hook-form field error message into a
 * prop bag to spread onto @markiro/ui form controls' `error?: string` prop.
 *
 * Needed because this project enables `exactOptionalPropertyTypes` (see
 * ../../tsconfig.base.json): passing `error={errors.field?.message}`
 * directly assigns the `error` key an explicit `string | undefined` value,
 * which does not satisfy a `error?: string` target under that flag (the key
 * must be entirely absent, not present-with-undefined). Spreading `{}` when
 * there's no message keeps the key genuinely absent.
 */
export function errorProp(message?: string): { error?: string } {
  return message === undefined ? {} : { error: message };
}
