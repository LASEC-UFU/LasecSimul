# 36 — Managed Toolchain Bootstrap and Dependency Manifest

**Status:** NOT STARTED  
**Priority:** Release-critical  
**Depends on:** `35`  
**Related:** `14`, `32`, `34`, `39`

## 1. Goal

Implement a secure, reproducible mechanism for downloading and managing runtime dependencies used by LasecSimul.

---

## 2. Canonical manifest

Bundle a signed/versioned manifest with the extension.

Conceptual:

```json
{
  "schemaVersion": 1,
  "bundleVersion": "2026.1",
  "components": [
    {
      "id": "python-runtime",
      "version": "3.x.y",
      "platform": "win32-x64",
      "url": "...",
      "sha256": "...",
      "size": 123456789,
      "archive": "zip",
      "licenseId": "...",
      "executable": "python/python.exe",
      "probe": ["--version"]
    }
  ]
}
```

The actual version fields are release-controlled.

Never use an unpinned `latest` URL in production bootstrap.

---

## 3. Manifest entries

For every external artifact record:
- component ID;
- version;
- platform;
- architecture;
- source URL;
- exact hash;
- archive format;
- unpacked layout;
- expected executable;
- health probe;
- license metadata;
- attribution;
- optional signature;
- compatibility with LasecSimul version/protocol.

---

## 4. Integrity verification

Mandatory:
1. download to staging;
2. verify expected byte count if provided;
3. verify SHA-256 at minimum;
4. verify signature if distribution strategy supports it;
5. extract into staging;
6. run health probe;
7. atomically activate.

Checksum mismatch:
- delete staging artifact;
- mark failed;
- never execute it.

---

## 5. Directory layout

Example:

```text
runtime/
├── inventory.json
├── staging/
├── python/
│   └── 3.x.y/
│       └── win32-x64/
├── ghdl/
│   └── 6.x/
│       └── win32-x64/
└── core-tools/
```

Do not mix versions in one directory.

---

## 6. Inventory

Maintain installed inventory:

```json
{
  "schemaVersion": 1,
  "installed": {
    "python-runtime": {
      "version": "...",
      "platform": "...",
      "path": "...",
      "health": "ok",
      "installedAt": "..."
    }
  }
}
```

Inventory is cache, not sole source of truth; health checks can revalidate files.

---

## 7. Transactional update

Never overwrite the active runtime in-place.

Use:

```text
download → verify → extract → probe → activate pointer
```

Rollback:
- keep previous version until new is healthy;
- restore pointer if activation fails.

---

## 8. Concurrency

Prevent two VS Code windows from installing the same runtime simultaneously.

Use:
- filesystem lock;
- install transaction identifier;
- stale-lock recovery.

---

## 9. Proxy/network

Use VS Code/Node networking facilities compatible with user proxy environment.

Surface:
- timeout;
- DNS;
- proxy authentication issue;
- TLS failure.

Do not bypass TLS verification.

---

## 10. Runtime source policy

Only download from explicitly approved release sources.

Do not construct arbitrary download URLs from workspace files.

Workspace configuration must not be able to replace trusted bootstrap URL in Restricted Mode.

---

## 11. License and attribution

Before shipping/downloading third-party runtimes:
- verify redistribution permission;
- include required license text;
- include notices/attributions;
- expose component source/license in Setup Center.

This is a release gate, not optional documentation.

---

## 12. GHDL provisioning

Managed GHDL entry:
- exact supported version;
- platform package;
- VPI capability probe if required;
- executable path;
- plugin compile/link tooling if required.

Health test should go beyond file existence.

Suggested:
```text
ghdl --version
```

and, when bridge is installed:
- minimal compile/run self-test.

---

## 13. Python provisioning

Managed Python entry:
- known compatible interpreter;
- isolated layout;
- no system PATH dependency;
- worker self-test;
- deterministic import paths.

Health:
```text
python --version
worker hello handshake
```

---

## 14. Core provisioning

Preferred Core binary may remain bundled inside platform-specific VSIX because it is tightly coupled to extension protocol.

If Core is downloaded:
- use exactly the same integrity/transaction rules.

---

## 15. Self-test suite

`Check Installation` should run:

```text
Core:
  executable launches
  IPC protocol compatible

Python:
  interpreter launches
  worker handshake
  basic arithmetic step

GHDL:
  executable launches
  compile minimal VHDL
  run minimal VHDL
  VPI bridge health when feature uses it

Assets:
  catalog index readable
  required built-in SVGs found
```

---

## 16. Disk-space preflight

Before download:
- compute known download size;
- estimate unpacked size;
- check destination free space where feasible;
- fail early with useful diagnostic.

---

## 17. Cancellation

Cancellation rules:
- active download can cancel;
- staging removed;
- previously active runtime untouched.

Do not leave half-extracted directory as active.

---

## 18. Offline install

Support an offline artifact set:

```text
lasecsimul-runtime-bundle-<version>-<platform>.zip
```

Setup Center command:
```text
Install Runtime Bundle from File...
```

Bundle uses same manifest and hashes.

This is important for laboratories/classrooms.

---

## 19. CI generation

Release CI should:
- resolve artifacts;
- compute hashes;
- generate manifest;
- run license checks;
- build platform VSIX;
- run install smoke tests.

Do not hand-edit production hashes.

---

## 20. Acceptance criteria

The runtime manager can install, verify, upgrade, repair and roll back Python/GHDL dependencies without PATH modification or admin access, using a reproducible manifest.
## 21. Shared runtime mode

The dependency manager supports two normal storage scopes:

```text
User runtime      — PersonalDesktop
Machine runtime   — SharedHost
```

Machine/shared runtime is normally installed by administrator/deployment tooling and is read-only to students.

The manifest, checksum and transactional activation model is identical for both.

---

## 22. Runtime resolution must be centralized

Create/extend one `RuntimeResolver`.

Tool-specific code asks:

```text
resolve("python")
resolve("ghdl")
resolve("qemu")  # only if managed
```

It must not implement separate ad-hoc path searches.

Resolution takes deployment policy into account.

---

## 23. Per-session writable workdirs

Even when executable/toolchain is shared, all mutable outputs use unique session storage.

Examples:
- Python cache/state;
- GHDL `work-obj*.cf`;
- waveform files;
- QEMU runtime files;
- IPC endpoints.

Shared-runtime installation must never become a shared mutable build directory.

---

## 24. Laboratory bundle

Produce a host-level offline runtime bundle compatible with imaging/deployment:

```text
lasecsimul-lab-runtime-<bundleVersion>-<platform>
```

The same bundle can be health-checked using the normal manifest logic.

See spec `45`.
