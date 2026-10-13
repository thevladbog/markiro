type JsonResponse = { json(): Promise<unknown> };

export async function readActionResponseBody(
  response: Promise<JsonResponse>,
  action: () => Promise<void>,
): Promise<unknown> {
  // Consume the browser-owned body as soon as headers arrive, not after click
  // auto-waiting/navigation can discard the protocol's response resource.
  const captured = response
    .then((value) => value.json())
    .then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
  await action();
  const result = await captured;
  if (!result.ok) throw result.error;
  return result.value;
}
