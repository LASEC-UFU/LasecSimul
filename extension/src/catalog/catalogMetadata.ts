import { McuSerialPortEntry } from "../ui/webview/model";

export function sanitizeMcuSerialPorts(value: unknown): McuSerialPortEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ports: McuSerialPortEntry[] = [];
  const seen = new Set<number>();
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const raw = entry as Record<string, unknown>;
    const usartIndex = typeof raw.usartIndex === "number" ? Math.floor(raw.usartIndex) : undefined;
    if (usartIndex !== 0 && usartIndex !== 1 && usartIndex !== 2) continue;
    if (typeof raw.label !== "string" || !raw.label.trim()) continue;
    if (seen.has(usartIndex)) continue;
    seen.add(usartIndex);
    ports.push({ label: raw.label.trim(), usartIndex });
  }
  return ports.length > 0 ? ports : undefined;
}

export function sanitizeMcuSerialPortsByTypeId(value: unknown): Record<string, McuSerialPortEntry[]> {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, McuSerialPortEntry[]> = {};
  for (const [typeId, rawPorts] of Object.entries(value as Record<string, unknown>)) {
    const trimmedTypeId = typeId.trim();
    if (!trimmedTypeId) continue;
    const ports = sanitizeMcuSerialPorts(rawPorts);
    if (ports) out[trimmedTypeId] = ports;
  }
  return out;
}
