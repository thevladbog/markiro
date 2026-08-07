export function assertManagedResourceInState(rawState, type, name, location) {
  let state;
  try {
    state = JSON.parse(rawState);
  } catch {
    throw new Error(`${location} is not valid Terraform state JSON`);
  }
  if (
    !Array.isArray(state.resources) ||
    !state.resources.some(
      (resource) =>
        resource?.mode === "managed" && resource.type === type && resource.name === name,
    )
  )
    throw new Error(`${location} does not contain ${type}.${name}`);
}
