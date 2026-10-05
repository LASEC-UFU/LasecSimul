/** Local id of the HART field device a subcircuit wraps (a transmitter such
 * as subcircuits/hart_smar_ld301 is a subcircuit around one standard HART
 * device), so HART transports can address that inner device. */
export function manifestHartDeviceComponentId(json: Record<string, unknown>): string | undefined {
  if (!Array.isArray(json.components)) return undefined;
  for (const component of json.components) {
    if (typeof component !== "object" || component === null) continue;
    const entry = component as Record<string, unknown>;
    if (typeof entry.typeId === "string" && entry.typeId.startsWith("protocol.hart.device.") && typeof entry.id === "string") return entry.id;
  }
  return undefined;
}
