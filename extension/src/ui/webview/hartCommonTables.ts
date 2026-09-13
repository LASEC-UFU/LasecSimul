/**
 * HART Common Tables catalog, derived from HCF_SPEC-183 rev. 22, §5 (the
 * licensed source PDF remains local only in HART.zip and is deliberately not
 * checked in).  A type always stores its numeric code; this catalog is a
 * presentation authority for Human/HEX editing, never protocol state.
 */
import { HART_COMMON_TABLE_VALUES } from "./hartCommonTablesData.js";
export type HartCommonTableKind = "enum" | "bit";

export interface HartCommonTable {
  id: number;
  name: string;
  kind: HartCommonTableKind;
  width: 1 | 2;
  values: Readonly<Record<number, string>>;
}

const bitTables = new Set([11, 17, 25, 26, 27, 28, 29, 30, 31, 32, 39, 41, 42, 46, 47, 52, 59, 60, 62, 63, 65, 68, 73, 75, 78, 79]);
const names = [
  "Command-specific response codes", "Expanded device type codes", "Engineering unit codes", "Transfer function codes", "Material codes", "NULL",
  "Alarm selection codes", "Write protect codes", "Manufacturer identification codes", "Burst mode control", "Physical signaling", "Flag assignments",
  "Transfer service function", "Transfer service identifier", "Operating mode", "Analog channel number", "Loop current mode", "Extended device status",
  "Lock device", "Write device variable", "Device variable family", "Device variable classification", "Trim point", "Capture mode", "Physical layer type",
  "Lock device status", "Analog channel flags", "Analog channel saturated", "Analog channel fixed", "Standardized status 0", "Standardized status 1",
  "Standardized status 2", "Standardized status 3", "Burst message trigger mode", "Device variable code", "Event notification control", "Event status",
  "Trend control", "Time-set", "Timetable request flags", "Timetable application domain", "Synchronous action control", "Real-time clock flags",
  "Wireless timer", "Device power source", "Link type", "Link option flags", "Superframe mode flags", "Session type", "Timetable deletion reason",
  "Disconnect cause", "Wireless operation mode", "Join process status", "Security type", "SI units control", "Device list", "Network access mode",
  "Device profile", "Device power status", "Neighbor flags", "Change notification flags", "Join mode", "Device scheduling flags", "Network optimization flags",
  "Packet receive priority", "Device variable properties", "Squawk control", "Event manager registration control", "Event manager registration status",
  "Location method", "Condensed status mapping", "Status simulation mode", "Simulated value", "Sub-device assignment status", "Sub-device assignment transfer",
  "Wireless capability flags", "CCA mode", "Wireless device connection status", "Wireless device health status", "Change key flags", "Join key mode",
] as const;

/** Semantic labels for values used in current HART commands/profiles.  Unknown
 * but valid values remain editable and are intentionally shown as HEX. */
const fallbackValues: Readonly<Record<number, Readonly<Record<number, string>>>> = {
  0: { 0: "No command-specific error", 2: "Invalid selection", 3: "Parameter too large", 4: "Parameter too small", 5: "Too few data bytes", 6: "Device-specific command error", 7: "Write protected", 8: "Update failure / in progress", 16: "Access restricted", 17: "Invalid device variable index", 18: "Invalid unit code", 29: "Invalid span", 32: "Busy" },
  3: { 0: "Linear", 1: "Square root", 2: "Square root, third power", 3: "Square root, fifth power", 4: "Special curve", 5: "Square", 230: "Discrete switch" },
  6: { 0: "High", 1: "Low", 239: "Hold last output value" },
  7: { 0: "Not write protected", 1: "Write protected" },
  9: { 0: "Off", 1: "Burst on token-passing", 2: "Burst on TDMA", 3: "Burst on both data links" },
  10: { 0: "Bell 202 current", 1: "Bell 202 voltage", 2: "RS-485", 3: "RS-232", 4: "Wireless", 6: "Special" },
  15: { 0: "Analog channel 0 (PV)", 1: "Analog channel 1 (SV)", 2: "Analog channel 2 (TV)", 3: "Analog channel 3 (QV)", 4: "Analog channel 4" },
  16: { 0: "Disabled", 1: "Enabled" },
  18: { 0: "Unlocked", 1: "Temporary lock", 2: "Permanent lock", 3: "Lock all" },
  19: { 0: "Normal", 1: "Fixed value" },
  20: { 4: "Temperature", 5: "Pressure", 6: "Valve / actuator", 7: "Simple PID", 8: "pH", 9: "Conductivity", 10: "Totalizer", 11: "Level", 12: "Vortex flow", 13: "Mag flow", 14: "Coriolis flow", 250: "Not used" },
  21: { 0: "Not classified", 64: "Temperature", 65: "Pressure", 66: "Volumetric flow", 67: "Velocity", 68: "Volume", 69: "Length", 70: "Time", 71: "Mass", 72: "Mass flow", 73: "Mass per volume", 74: "Viscosity", 75: "Angular velocity", 76: "Area", 77: "Energy", 78: "Force", 79: "Power", 80: "Frequency", 81: "Analytical", 82: "Capacitance", 83: "Electric potential", 84: "Current", 85: "Resistance", 86: "Angle", 87: "Conductance", 88: "Volume per volume", 89: "Volume per mass", 90: "Concentration", 96: "Acceleration", 97: "Turbidity", 98: "Temperature difference", 99: "Volumetric gas flow / second", 100: "Volumetric gas flow / minute", 101: "Volumetric gas flow / hour", 102: "Volumetric gas flow / day", 103: "Volumetric liquid flow / second", 104: "Volumetric liquid flow / minute", 105: "Volumetric liquid flow / hour", 106: "Volumetric liquid flow / day", 107: "Thermal expansion" },
  22: { 0: "No trim points", 1: "Lower trim point", 2: "Upper trim point", 3: "Lower and upper trim points" },
  23: { 0: "Disabled", 1: "Catch specified field device", 2: "Catch BACK message" },
  24: { 0: "Asynchronous", 1: "Synchronous", 3: "Reserved" },
  33: { 0: "Continuous", 1: "Window", 2: "Rising", 3: "Falling", 4: "On-change" },
  34: { 243: "Battery life", 244: "Percent range", 245: "Loop current", 246: "Primary variable", 247: "Secondary variable", 248: "Tertiary variable", 249: "Quaternary variable", 250: "Not used" },
  35: { 0: "Disabled", 1: "Enabled" }, 37: { 0: "Disabled", 1: "Enabled" }, 38: { 0: "Do not set", 1: "Set time" },
  40: { 0: "Publish", 1: "Event", 2: "Maintenance", 3: "Block transfer" },
  43: { 0: "Discovery", 1: "Advertisement", 2: "Keep-alive", 3: "Path failure", 4: "Health report", 5: "Broadcast reply", 6: "Maximum PDU age", 7: "Maximum reply time" },
  44: { 0: "Line power", 1: "Battery", 2: "Rechargeable / scavenged" }, 45: { 0: "Normal", 1: "Discovery", 2: "Broadcast", 3: "Join" },
  48: { 0: "Unicast", 1: "Broadcast", 2: "Join" }, 49: { 0: "Requested by peer", 1: "Service cannot be established", 2: "Network failure" },
  50: { 0: "User initiated", 1: "Communication failure" }, 51: { 0: "Idle", 1: "Active search", 2: "Negotiating", 3: "Quarantined", 4: "Operational", 5: "Suspended", 6: "Deep sleep / passive search" },
  53: { 0: "Session keyed", 1: "Join keyed", 2: "Reserved" }, 54: { 0: "No restriction", 1: "SI units only" },
  55: { 0: "Active list", 1: "Whitelist", 2: "Blacklist", 3: "Network list", 4: "Quarantine list", 5: "Rejected list", 6: "Access point list" },
  56: { 0: "Open", 1: "Whitelist", 2: "Blacklist", 3: "Whitelist and blacklist", 4: "Lockdown", 5: "Quarantine" },
  58: { 0: "Nominal", 1: "Low", 2: "Critically low", 3: "Recharging - low", 4: "Recharging - high" },
  61: { 0: "Do not join", 1: "Join now", 2: "Join after power-up/reset" }, 64: { 0: "Command", 1: "Process data", 2: "Normal", 3: "Alarm" },
  66: { 0: "Off", 1: "On", 2: "Squawk once" }, 67: { 0: "Register", 1: "De-register", 2: "Reset" },
  69: { 0: "No fix", 1: "GPS/SPS", 2: "Differential GPS", 3: "PPS", 4: "RTK fixed", 5: "RTK float", 6: "Dead reckoning", 7: "Manual", 8: "Simulation" },
  70: { 0: "No effect", 1: "Maintenance required", 3: "Failure", 4: "Out of specification", 5: "Function check", 6: "Not defined" },
  71: { 0: "Disabled", 1: "Enabled" }, 72: { 0: "Reset", 1: "Set" }, 74: { 0: "Transfer all identity", 1: "Transfer all except device ID" },
  76: { 0: "CCA disabled", 1: "Energy detect", 2: "Carrier sense", 3: "Carrier sense + energy detect" },
  77: { 1: "Operational", 2: "Disconnected", 3: "Attempting join", 4: "Quarantined" }, 80: { 0: "Normal", 1: "Common join key", 2: "Well-known key" },
  11: { 1: "Multi-sensor", 2: "EEPROM control", 4: "Protocol bridge", 8: "IEEE 802.15.4", 64: "C8PSK capable", 128: "C8PSK multidrop only" },
  17: { 1: "Maintenance required", 2: "Device variable alert", 4: "Critical power failure", 8: "Failure", 16: "Out of specification", 32: "Function check" },
  25: { 1: "Device locked", 2: "Permanent lock", 4: "Locked by primary master", 8: "Configuration locked", 16: "Locked by gateway" },
  39: { 1: "Source", 2: "Sink", 4: "Intermittent" }, 41: { 1: "Command", 16: "One-shot", 128: "Action enabled" },
  42: { 1: "Non-volatile clock", 2: "Clock uninitialized" }, 46: { 1: "Transmit", 2: "Receive", 4: "Shared" }, 47: { 1: "Active", 128: "Handheld superframe" },
  52: { 1: "Network packets heard", 2: "ASN acquired", 4: "Slot synchronized", 8: "Advertisement heard", 16: "Join requested", 32: "Join retrying", 64: "Join failed", 128: "Authenticated", 256: "Network joined", 512: "Negotiating", 1024: "Normal operation commencing" },
  59: { 1: "Time source", 128: "No links to neighbor" }, 62: { 1: "Transient", 2: "Non-routing", 4: "Handheld" }, 63: { 1: "Low latency", 2: "Line-powered backbone" },
  65: { 1: "Not calculated by field device", 128: "Simulated" }, 68: { 1: "Event manager registered", 2: "Requesting client is event manager" },
  73: { 1: "Device not found by ID", 2: "Device not found by long tag", 4: "Older device revision", 8: "Newer device revision" }, 75: { 8: "Saturating counters" },
  78: { 16: "Stale data alarm" }, 79: { 1: "Network key", 2: "Join key", 4: "Session keys" },
};

// HCF_SPEC-183 is authoritative for tables 1-80.  The only extra map is
// ENUM00, the command-specific response-code vocabulary from the command
// specifications.  The generated Common-Table data wins where both exist.
const values: Readonly<Record<number, Readonly<Record<number, string>>>> = {
  ...fallbackValues,
  ...HART_COMMON_TABLE_VALUES,
};

export const HART_COMMON_TABLES: ReadonlyArray<HartCommonTable> = names.map((name, id) => ({
  id,
  name,
  kind: bitTables.has(id) ? "bit" : "enum",
  width: id === 1 || id === 52 || id === 60 ? 2 : 1,
  values: values[id] ?? {},
}));

export function hartVariableTypeOptions(): ReadonlyArray<{ value: string; label: string }> {
  const primitive = [
    { value: "Float32", label: "Float32 (IEEE-754)" }, { value: "UInt8", label: "UInt8" }, { value: "UInt16", label: "UInt16" },
    { value: "Int16", label: "Int16" }, { value: "PackedAscii", label: "Packed ASCII" }, { value: "Bool", label: "Boolean" },
  ];
  return primitive.concat(HART_COMMON_TABLES.map((table) => ({
    value: `${table.kind === "bit" ? "BIT_ENUM" : "ENUM"}${String(table.id).padStart(2, "0")}`,
    label: `${table.kind === "bit" ? "BIT_ENUM" : "ENUM"}${String(table.id).padStart(2, "0")} — ${table.name}`,
  })));
}

export function hartCommonTableForType(type: unknown): HartCommonTable | undefined {
  const match = /^(BIT_ENUM|ENUM)(\d{2})$/.exec(String(type));
  if (!match) return undefined;
  const table = HART_COMMON_TABLES[Number(match[2])];
  return table && ((match[1] === "BIT_ENUM") === (table.kind === "bit")) ? table : undefined;
}

export function formatHartHex(value: unknown, width = 1): string {
  const numeric = typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  return `0x${numeric.toString(16).toUpperCase().padStart(width * 2, "0")}`;
}
