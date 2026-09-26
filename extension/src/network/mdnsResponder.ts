import * as dgram from "dgram";
import { logSimulation } from "../diagnostics/simulationLog";

/**
 * Host-side mDNS responder for the transparent Wi-Fi "isolated" (SLIRP) mode.
 *
 * In isolated mode the ESP32 guest sits behind QEMU's SLIRP NAT: the hostname it
 * advertises over mDNS (`<host>.local`) never reaches the host's own mDNS
 * resolver, so `ping esp32.local` / `Resolve-DnsName esp32.local` fail on the
 * same PC even though the guest's services are reachable on 127.0.0.1 (via the
 * SLIRP hostfwd rules the Core installs). A responder built into QEMU cannot fix
 * this -- QEMU's SLIRP multicast and the OS resolver are on different network
 * paths (verified). So the actual responder lives here, in the extension, on the
 * host's real interface:
 *
 *   - QEMU learns the `<host>.local` name from the guest's mDNS transmissions
 *     (hw/misc/esp32_wifi_mdns.c) and sends it to us as a plain UDP datagram on
 *     127.0.0.1:<feed port>.
 *   - We answer any mDNS query for a learned name with an A record -> 127.0.0.1,
 *     both unicast to the querier and multicast, so the Windows DNS Client
 *     resolves `<host>.local` on the same machine.
 *
 * This is a same-PC convenience for isolated mode only. Multi-ESP32 setups use
 * lab-router/lab-bridge, which put every guest on a real TAP interface with its
 * own IP, where ordinary mDNS already works and this responder stays off.
 */

const MDNS_GROUP = "224.0.0.251";
const MDNS_PORT = 5353;
const LOOPBACK_A = Buffer.from([127, 0, 0, 1]);
/** Fixed loopback port QEMU feeds learned hostnames to. Bound with SO_REUSEADDR
 * so several VS Code windows on one PC share it harmlessly (every responder just
 * answers the same 127.0.0.1). Also passed to QEMU via env. */
export const MDNS_FEED_PORT = 42353;
/** Re-announce learned names periodically so a resolver that missed the reply (or
 * started after) still populates its cache. */
const ANNOUNCE_INTERVAL_MS = 2000;

export interface MdnsResponderHandle {
  readonly feedPort: number;
  dispose(): void;
}

/** Read a DNS name at buf[off]: dotted, lowercase, no trailing dot. Follows
 * compression pointers but reports the offset just after the name at this level.
 * Returns undefined on malformed input. */
function readName(buf: Buffer, off: number): { name: string; after: number } | undefined {
  const labels: string[] = [];
  let o = off;
  let jumped = false;
  let after = -1;
  let guard = 0;
  while (o >= 0 && o < buf.length) {
    const len = buf[o];
    if (len === undefined) return undefined;
    if ((len & 0xc0) === 0xc0) {
      const lo = buf[o + 1];
      if (lo === undefined) return undefined;
      if (!jumped) after = o + 2;
      o = ((len & 0x3f) << 8) | lo;
      jumped = true;
      if (++guard > 128) return undefined;
      continue;
    }
    if (len === 0) {
      if (!jumped) after = o + 1;
      break;
    }
    o++;
    if (o + len > buf.length) return undefined;
    labels.push(buf.slice(o, o + len).toString("latin1"));
    o += len;
    if (++guard > 128) return undefined;
  }
  if (after < 0) return undefined;
  return { name: labels.join(".").toLowerCase(), after };
}

/** Build an mDNS answer: `name` A (cache-flush) -> 127.0.0.1, TTL 120. */
function buildResponse(name: string): Buffer {
  const nameBuf = Buffer.concat([
    ...name.split(".").map((label) =>
      Buffer.concat([Buffer.from([label.length]), Buffer.from(label, "latin1")]),
    ),
    Buffer.from([0]),
  ]);
  const header = Buffer.from([0, 0, 0x84, 0x00, 0, 0, 0, 1, 0, 0, 0, 0]); // QR+AA, 1 answer
  const rr = Buffer.concat([
    nameBuf,
    Buffer.from([0, 1]), // type A
    Buffer.from([0x80, 1]), // class IN + cache-flush
    Buffer.from([0, 0, 0, 120]), // TTL
    Buffer.from([0, 4]), // rdlength
    LOOPBACK_A,
  ]);
  return Buffer.concat([header, rr]);
}

/** Start the isolated-mode responder. Returns a handle (with the feed port to
 * pass to QEMU) or undefined if the sockets could not be created -- a failure
 * here must never take down the extension host, just disable `.local` on the
 * same PC. */
export function startIsolatedMdnsResponder(): MdnsResponderHandle | undefined {
  const known = new Set<string>();
  let announceTimer: NodeJS.Timeout | undefined;

  const responder = dgram.createSocket({ type: "udp4", reuseAddr: true });
  const feed = dgram.createSocket({ type: "udp4", reuseAddr: true });

  const announce = (name: string): void => {
    try {
      const resp = buildResponse(name);
      responder.send(resp, MDNS_PORT, MDNS_GROUP);
    } catch {
      /* transient send failure -- the periodic re-announce covers it */
    }
  };

  responder.on("error", (err) => {
    logSimulation("warning", `Responder mDNS (isolado) desativado: ${err.message}`, {
      stage: "network-mdns",
    });
  });
  feed.on("error", (err) => {
    logSimulation("warning", `Canal de hostname mDNS indisponível: ${err.message}`, {
      stage: "network-mdns",
    });
  });

  responder.on("message", (msg, rinfo) => {
    if (msg.length < 12 || ((msg[2] ?? 0) & 0x80) !== 0) return; // queries only
    const qd = ((msg[4] ?? 0) << 8) | (msg[5] ?? 0);
    let off = 12;
    for (let i = 0; i < qd; i++) {
      const parsed = readName(msg, off);
      if (!parsed) return;
      const qtype = ((msg[parsed.after] ?? 0) << 8) | (msg[parsed.after + 1] ?? 0);
      off = parsed.after + 4;
      if ((qtype === 1 || qtype === 255) && known.has(parsed.name)) {
        const resp = buildResponse(parsed.name);
        try {
          responder.send(resp, MDNS_PORT, MDNS_GROUP); // multicast (fills the group cache)
        } catch { /* covered by the periodic re-announce */ }
        try {
          responder.send(resp, rinfo.port, rinfo.address); // unicast to the querier
        } catch { /* querier gone; multicast still delivered */ }
      }
    }
  });

  feed.on("message", (msg) => {
    const name = msg.toString("utf8").trim().toLowerCase();
    if (!name || name.length > 255 || !name.endsWith(".local")) return;
    if (!known.has(name)) {
      known.add(name);
      logSimulation("info", `mDNS isolado: respondendo ${name} -> 127.0.0.1`, {
        stage: "network-mdns",
      });
    }
    announce(name); // answer immediately so a resolver already waiting catches it
  });

  try {
    responder.bind(MDNS_PORT, () => {
      try {
        responder.addMembership(MDNS_GROUP);
      } catch {
        /* another mDNS stack already owns the group membership -- unicast replies still work */
      }
      try {
        responder.setMulticastLoopback(true);
      } catch {
        /* not essential; loopback delivery is best-effort */
      }
    });
    feed.bind(MDNS_FEED_PORT, "127.0.0.1");
  } catch (err) {
    logSimulation("warning", `Não foi possível iniciar o responder mDNS isolado: ${
      err instanceof Error ? err.message : String(err)
    }`, { stage: "network-mdns" });
    try { responder.close(); } catch { /* already closed */ }
    try { feed.close(); } catch { /* already closed */ }
    return undefined;
  }

  announceTimer = setInterval(() => {
    for (const name of known) announce(name);
  }, ANNOUNCE_INTERVAL_MS);
  if (typeof announceTimer.unref === "function") announceTimer.unref();

  return {
    feedPort: MDNS_FEED_PORT,
    dispose(): void {
      if (announceTimer) {
        clearInterval(announceTimer);
        announceTimer = undefined;
      }
      try { responder.close(); } catch { /* already closed */ }
      try { feed.close(); } catch { /* already closed */ }
    },
  };
}
