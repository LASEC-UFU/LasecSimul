import { execFile } from "child_process";
import * as fs from "fs";

/** `reg query HKLM\HARDWARE\DEVICEMAP\SERIALCOMM` -> port names (COMx, and
 * the com0com pair ends CNCAx/CNCBx). */
export function parseSerialCommRegistry(output: string): string[] {
  const ports: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /\sREG_SZ\s+(\S+)\s*$/.exec(line);
    if (match?.[1]) ports.push(match[1]);
  }
  return sortPortNames(ports);
}

/** Natural order: COM2 before COM10, then CNCA/CNCB pairs. */
export function sortPortNames(ports: string[]): string[] {
  const split = (name: string): [string, number] => {
    const match = /^(.*?)(\d+)$/.exec(name);
    return match ? [match[1]!, Number(match[2])] : [name, -1];
  };
  return [...new Set(ports)].sort((a, b) => {
    const [prefixA, numberA] = split(a);
    const [prefixB, numberB] = split(b);
    return prefixA === prefixB ? numberA - numberB : prefixA.localeCompare(prefixB);
  });
}

/** Serial ports present on this computer, for the HART modem's PC side. */
export function listHostSerialPorts(): Promise<string[]> {
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      execFile("reg", ["query", "HKLM\\HARDWARE\\DEVICEMAP\\SERIALCOMM"], { windowsHide: true, timeout: 3000 }, (error, stdout) => {
        resolve(error ? [] : parseSerialCommRegistry(String(stdout)));
      });
    });
  }
  try {
    const pattern = process.platform === "darwin" ? /^cu\./ : /^tty(S|USB|ACM|AMA)\d+$/;
    return Promise.resolve(sortPortNames(fs.readdirSync("/dev").filter((name) => pattern.test(name)).map((name) => `/dev/${name}`)));
  } catch {
    return Promise.resolve([]);
  }
}
