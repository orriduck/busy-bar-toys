/** Keep the guide aligned with cloud_registration.valid_id on the local host. */
export function validServiceIdentifier(value: string) {
  return (
    /^[A-Za-z0-9_-]{1,64}$/.test(value) &&
    !["__proto__", "constructor", "prototype"].includes(value)
  );
}

export function sourceRouteCommand(source: string, id: string) {
  const clean = source.trim();
  if (
    !validServiceIdentifier(clean) ||
    !validServiceIdentifier(id) ||
    /[\x00-\x1f\x7f]/.test(source)
  )
    return null;
  const separator = clean.startsWith("-") || id.startsWith("-") ? "-- " : "";
  return `busy-bar cloud-route ${separator}${clean} ${id}`;
}
