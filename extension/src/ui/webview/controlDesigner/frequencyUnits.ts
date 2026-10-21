import type { FrequencyUnit, TimeUnit } from "./types.js";

export const FREQUENCY_UNIT_OPTIONS: readonly { value: FrequencyUnit; label: string }[] = [
  { value: "auto", label: "auto" },
  { value: "rad/s", label: "rad/s" }, { value: "Hz", label: "Hz" }, { value: "rpm", label: "rpm" },
  { value: "kHz", label: "kHz" }, { value: "MHz", label: "MHz" }, { value: "GHz", label: "GHz" },
  { value: "rad/nanosecond", label: "rad/ns" }, { value: "rad/microsecond", label: "rad/µs" },
  { value: "rad/millisecond", label: "rad/ms" }, { value: "rad/minute", label: "rad/min" },
  { value: "rad/hour", label: "rad/h" }, { value: "rad/day", label: "rad/day" },
  { value: "rad/week", label: "rad/week" }, { value: "rad/month", label: "rad/month" }, { value: "rad/year", label: "rad/year" },
  { value: "cycles/nanosecond", label: "cycles/ns" }, { value: "cycles/microsecond", label: "cycles/µs" },
  { value: "cycles/millisecond", label: "cycles/ms" }, { value: "cycles/hour", label: "cycles/h" },
  { value: "cycles/day", label: "cycles/day" }, { value: "cycles/week", label: "cycles/week" },
  { value: "cycles/month", label: "cycles/month" }, { value: "cycles/year", label: "cycles/year" },
  { value: "rad/sample", label: "rad/sample" },
];

export const TIME_UNIT_SECONDS: Record<TimeUnit, number> = {
  nanoseconds: 1e-9, microseconds: 1e-6, milliseconds: 1e-3, seconds: 1,
  minutes: 60, hours: 3600, days: 86400, weeks: 604800, months: 30 * 86400, years: 365 * 86400,
};

export function frequencyUnitScale(unit: FrequencyUnit, timeUnit: TimeUnit = "seconds", sampleTime = 1): number {
  if (unit === "auto") return TIME_UNIT_SECONDS[timeUnit];
  if (unit === "rad/sample") return sampleTime;
  if (unit === "rad/s") return 1;
  if (unit === "Hz") return 1 / (2 * Math.PI);
  if (unit === "rpm") return 60 / (2 * Math.PI);
  if (unit === "kHz") return 1 / (2 * Math.PI * 1e3);
  if (unit === "MHz") return 1 / (2 * Math.PI * 1e6);
  if (unit === "GHz") return 1 / (2 * Math.PI * 1e9);
  const [kind, period] = unit.split("/") as ["rad" | "cycles", string];
  const seconds: Record<string, number> = {
    nanosecond: 1e-9, microsecond: 1e-6, millisecond: 1e-3, minute: 60,
    hour: 3600, day: 86400, week: 604800, month: 30 * 86400, year: 365 * 86400,
  };
  const scale = seconds[period] ?? Number.NaN;
  return kind === "cycles" ? scale / (2 * Math.PI) : scale;
}

export function frequencyToDisplay(omegaRadPerSecond: number, unit: FrequencyUnit, sampleTime: number, timeUnit: TimeUnit = "seconds"): number {
  return omegaRadPerSecond * frequencyUnitScale(unit, timeUnit, sampleTime);
}

export function frequencyFromDisplay(value: number, unit: FrequencyUnit, sampleTime: number, timeUnit: TimeUnit = "seconds"): number {
  return value / frequencyUnitScale(unit, timeUnit, sampleTime);
}

export type FrdFrequencyUnit = FrequencyUnit | "rad/TimeUnit" | "cycles/TimeUnit";
export function frdFrequencyToRadPerSecond(value: number, unit: FrdFrequencyUnit, sampleTime: number, timeUnit: TimeUnit = "seconds"): number {
  if (unit === "rad/TimeUnit") return value / TIME_UNIT_SECONDS[timeUnit];
  if (unit === "cycles/TimeUnit") return value * 2 * Math.PI / TIME_UNIT_SECONDS[timeUnit];
  return frequencyFromDisplay(value, unit, sampleTime, timeUnit);
}

export function frequencyUnitLabel(unit: FrequencyUnit, timeUnit: TimeUnit = "seconds"): string {
  if (unit !== "auto") return FREQUENCY_UNIT_OPTIONS.find(option => option.value === unit)?.label ?? unit;
  const labels: Record<TimeUnit, string> = { nanoseconds: "rad/ns", microseconds: "rad/µs", milliseconds: "rad/ms", seconds: "rad/s", minutes: "rad/min", hours: "rad/h", days: "rad/day", weeks: "rad/week", months: "rad/month", years: "rad/year" };
  return labels[timeUnit];
}
