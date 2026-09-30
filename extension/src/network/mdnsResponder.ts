import * as dgram from "dgram";
import * as os from "os";
import { logSimulation } from "../diagnostics/simulationLog";

/**
 * Host-side mDNS responder for the transparent Wi-Fi network modes.
 *
 * Windows' built-in `.local` resolver is unreliable for a guest reached over a
 * secondary/virtual interface (QEMU SLIRP, or a routed TAP on a domain-joined
 * host), so `ping <host>.local` / `socket.gethostbyname` fail even when the guest
 * is up. This responder answers those queries authoritatively on the host, which
 * the Windows DNS Client does accept. Two modes:
 *
 *   - **isolated (SLIRP)**: the guest has no host-reachable IP (it sits behind
 *     QEMU's NAT); its services are on 127.0.0.1 via hostfwd. QEMU can't reach the
 *     host's resolver over SLIRP, so it learns the `<host>.local` name from the
 *     guest's mDNS transmissions and feeds it to us over loopback UDP
 *     (127.0.0.1:MDNS_FEED_PORT). We answer every learned name -> 127.0.0.1.
 *
 *   - **lab-router (TAP + gateway)**: each guest has its OWN routable IP on the
 *     TAP (10.<ns>.<slot>.15). Its mDNS announcements DO reach the host over the
 *     TAP (the gateway forwards multicast), so we learn `<host>.local -> real IP`
 *     straight from the wire and answer with that real IP. This serves any number
 *     of guests (thin-client, one ESP per session): every name resolves to its own
 *     reachable address, no loopback collision.
 */

const MDNS_GROUP = "224.0.0.251";
const MDNS_PORT = 5353;
/** Fixed loopback port QEMU feeds learned hostnames to (isolated only). Bound with
 * SO_REUSEADDR so several VS Code sessions on one PC share it harmlessly. */
export const MDNS_FEED_PORT = 42353;
/** Re-announce learned names periodically so a resolver that missed the reply (or
 * started after) still populates its cache. */
const ANNOUNCE_INTERVAL_MS = 2000;

export interface MdnsResponderHandle {
  readonly feedPort: number;
  dispose(): void;
}

export interface MdnsResponderOptions {
  /** true (isolated): answer every learned name -> 127.0.0.1, learning names from
   * the QEMU loopback feed. false (lab-router): answer each name -> the guest's
   * real TAP IP, learned from the guest's own mDNS A-record announcements. */
  loopbackOnly: boolean;
}

/** Read a DNS name at buf[off]: dotted, lowercase, no trailing dot. Follows
 * compression pointers but reports the offset just after the name at this level. */
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

/** Build an mDNS answer: `name` A (cache-flush) -> `ip`, TTL 120. */
function buildAnswer(name: string, ip: string): Buffer {
  const octets = ip.split(".").map((n) => parseInt(n, 10) & 0xff);
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
    Buffer.from(octets),
  ]);
  return Buffer.concat([header, rr]);
}

/** A guest IP we are willing to hand out for lab-router: a real, reachable address,
 * not loopback / APIPA / unspecified / multicast. */
function isReachableGuestIp(ip: string): boolean {
  const p = ip.split(".").map((n) => parseInt(n, 10));
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  const [a, b] = [p[0] ?? 0, p[1] ?? 0];
  if (a === 0 || a === 127) return false; // unspecified / loopback
  if (a === 169 && b === 254) return false; // APIPA
  if (a >= 224) return false; // multicast / reserved
  return true;
}

/** Extract A records (name -> IPv4) from an mDNS response message. */
function extractARecords(msg: Buffer): Array<{ name: string; ip: string }> {
  const out: Array<{ name: string; ip: string }> = [];
  if (msg.length < 12) return out;
  const qd = ((msg[4] ?? 0) << 8) | (msg[5] ?? 0);
  const an = ((msg[6] ?? 0) << 8) | (msg[7] ?? 0);
  let off = 12;
  for (let i = 0; i < qd; i++) {
    const p = readName(msg, off);
    if (!p) return out;
    off = p.after + 4;
    if (off > msg.length) return out;
  }
  for (let i = 0; i < an; i++) {
    const p = readName(msg, off);
    if (!p) return out;
    off = p.after;
    if (off + 10 > msg.length) return out;
    const type = ((msg[off] ?? 0) << 8) | (msg[off + 1] ?? 0);
    const rdlen = ((msg[off + 8] ?? 0) << 8) | (msg[off + 9] ?? 0);
    off += 10;
    if (off + rdlen > msg.length) return out;
    if (type === 1 && rdlen === 4) {
      out.push({
        name: p.name,
        ip: `${msg[off] ?? 0}.${msg[off + 1] ?? 0}.${msg[off + 2] ?? 0}.${msg[off + 3] ?? 0}`,
      });
    }
    off += rdlen;
  }
  return out;
}

function localIpv4Addresses(): string[] {
  const out: string[] = [];
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const info of list ?? []) {
        if (info.family === "IPv4" && !info.internal) out.push(info.address);
      }
    }
  } catch {
    /* best effort; INADDR_ANY membership below still covers the default interface */
  }
  return out;
}

/** Start the host-side responder. Returns a handle or undefined if the sockets
 * could not be created -- a failure here must never take down the extension host,
 * just disable `.local` resolution. */
export function startMdnsResponder(options: MdnsResponderOptions): MdnsResponderHandle | undefined {
  const known = new Map<string, string>(); // <host>.local -> IP to answer with
  let announceTimer: NodeJS.Timeout | undefined;

  const responder = dgram.createSocket({ type: "udp4", reuseAddr: true });
  const feed = dgram.createSocket({ type: "udp4", reuseAddr: true });

  const announce = (name: string, ip: string): void => {
    try {
      responder.send(buildAnswer(name, ip), MDNS_PORT, MDNS_GROUP);
    } catch {
      /* transient send failure -- the periodic re-announce covers it */
    }
  };

  const learn = (name: string, ip: string, source: string): void => {
    if (known.get(name) === ip) return;
    known.set(name, ip);
    logSimulation("info", `mDNS (${source}): ${name} -> ${ip}`, { stage: "network-mdns" });
    announce(name, ip);
  };

  responder.on("error", (err) => {
    logSimulation("warning", `Responder mDNS desativado: ${err.message}`, { stage: "network-mdns" });
  });
  feed.on("error", (err) => {
    logSimulation("warning", `Canal de hostname mDNS indisponível: ${err.message}`, {
      stage: "network-mdns",
    });
  });

  responder.on("message", (msg, rinfo) => {
    const isResponse = ((msg[2] ?? 0) & 0x80) !== 0;
    if (isResponse) {
      // lab-router: learn <host>.local -> real IP straight from the guest's own
      // mDNS announcements (they reach the host over the TAP). Isolated ignores the
      // wire and trusts only the loopback feed (SLIRP IPs are not host-reachable).
      if (options.loopbackOnly) return;
      for (const rec of extractARecords(msg)) {
        if (rec.name.endsWith(".local") && isReachableGuestIp(rec.ip)) {
          learn(rec.name, rec.ip, "lab-router");
        }
      }
      return;
    }
    // A query: answer any name we know, unicast to the querier and multicast.
    const qd = ((msg[4] ?? 0) << 8) | (msg[5] ?? 0);
    let off = 12;
    for (let i = 0; i < qd; i++) {
      const parsed = readName(msg, off);
      if (!parsed) return;
      const qtype = ((msg[parsed.after] ?? 0) << 8) | (msg[parsed.after + 1] ?? 0);
      off = parsed.after + 4;
      const ip = known.get(parsed.name);
      if ((qtype === 1 || qtype === 255) && ip) {
        const resp = buildAnswer(parsed.name, ip);
        try { responder.send(resp, MDNS_PORT, MDNS_GROUP); } catch { /* re-announced periodically */ }
        try { responder.send(resp, rinfo.port, rinfo.address); } catch { /* querier gone */ }
      }
    }
  });

  feed.on("message", (msg) => {
    // Isolated only: QEMU feeds the learned hostname over loopback; answer 127.0.0.1.
    if (!options.loopbackOnly) return;
    const name = msg.toString("utf8").trim().toLowerCase();
    if (!name || name.length > 255 || !name.endsWith(".local")) return;
    learn(name, "127.0.0.1", "isolado");
  });

  try {
    responder.bind(MDNS_PORT, () => {
      // Join the multicast group on every local interface so a guest announcing on
      // the TAP (lab-router) is heard, not just the default route.
      try { responder.addMembership(MDNS_GROUP); } catch { /* default iface already joined elsewhere */ }
      for (const addr of localIpv4Addresses()) {
        try { responder.addMembership(MDNS_GROUP, addr); } catch { /* already joined / iface busy */ }
      }
      try { responder.setMulticastLoopback(true); } catch { /* best-effort */ }
    });
    feed.bind(MDNS_FEED_PORT, "127.0.0.1");
  } catch (err) {
    logSimulation("warning", `Não foi possível iniciar o responder mDNS: ${
      err instanceof Error ? err.message : String(err)
    }`, { stage: "network-mdns" });
    try { responder.close(); } catch { /* already closed */ }
    try { feed.close(); } catch { /* already closed */ }
    return undefined;
  }

  announceTimer = setInterval(() => {
    for (const [name, ip] of known) announce(name, ip);
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
