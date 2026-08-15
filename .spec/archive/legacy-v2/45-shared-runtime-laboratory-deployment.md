# 45 — Shared Runtime and Laboratory Deployment

**Status:** PLANNED  
**Priority:** High for labs  
**Depends on:** `35`, `36`, `44`  
**Related:** `34`, `39`, `48`

## 1. Goal

Avoid duplicating large runtimes such as Python and GHDL in every thin-client user profile.

Provide:
- one shared read-only runtime installation per host;
- per-user/per-session mutable state isolation;
- normal per-user runtime for personal Desktop installations;
- one architecture and one extension.

---

## 2. Runtime types

### 2.1 Extension-bundled

Small tightly coupled artifacts:
- Core executable if packaging permits;
- schemas;
- built-in assets;
- bootstrap code.

### 2.2 User-managed runtime

Personal Desktop default:

```text
<UserExtensionStorage>/runtime/
```

### 2.3 Shared host runtime

Laboratory:

```text
MachineSharedRoot/runtime/
```

Example Windows candidate:

```text
C:\ProgramData\LasecSimul\runtime\
```

Example Linux candidate:

```text
/opt/lasecsimul/runtime/
```

Exact locations must follow OS packaging/permission conventions.

### 2.4 Custom runtime

Advanced explicit override.

---

## 3. RuntimeResolver

All external tool discovery goes through one service.

Resolution intent:

```text
explicit approved override
    ↓
shared lab runtime if configured
    ↓
user managed runtime
    ↓
bundled runtime
    ↓
optional system-path fallback if policy permits
```

Do not duplicate lookup logic in Python/GHDL/QEMU controllers.

---

## 4. Shared runtime contents

May contain:
- managed Python interpreter;
- Python worker support library;
- GHDL;
- reusable read-only device assets;
- static toolchain libraries;
- common examples if desired.

Mutable project build state MUST NOT live here.

---

## 5. Per-session mutable state

Always isolated:

```text
session/
├── ipc/
├── logs/
├── python/
│   ├── state/
│   └── __pycache__/ if permitted
├── ghdl/
│   └── work/
├── qemu/
├── waveform/
└── temp/
```

The shared runtime is executable/read-only content.

---

## 6. Security and permissions

Shared runtime:
- installed/updated by administrator or trusted deployment process;
- ordinary students receive read/execute;
- students do not modify tool binaries;
- hash/inventory can verify integrity.

Per-session storage:
- owned by the user/session;
- no cross-user access beyond OS policy.

---

## 7. First-run behavior on SharedHost

If administrator pre-provisioned the host:
- extension detects policy;
- validates shared runtime;
- no large per-user download;
- no repeated setup prompt.

User may see a one-time lightweight message:
```text
LasecSimul laboratory environment detected. Runtime ready.
```

Prefer no modal prompt when fully provisioned.

---

## 8. Administrator bootstrap

Provide supported lab workflow:

```text
1. install LasecSimul extension or VSIX
2. install shared runtime bundle once
3. write machine policy
4. run host self-test
5. make runtime read-only to students
```

Command-line bootstrap may be added for deployment tools.

---

## 9. Offline laboratory bundle

Provide:

```text
lasecsimul-lab-runtime-<version>-<platform>.zip
```

or platform installer/package.

Contains exact manifest and hashes.

Important for laboratories with:
- restricted internet;
- proxy;
- imaging;
- frozen workstations.

---

## 10. Update model

Administrator updates shared runtime once.

Safe process:
```text
download new version
verify
extract versioned directory
health test
switch active pointer/config
keep previous known-good
```

Do not modify active files in place.

---

## 11. Extension/runtime compatibility

Every runtime has compatibility metadata.

Example:
```text
extension protocol version
Core protocol version
Python worker protocol
GHDL bridge version
```

If an extension update requires a newer shared runtime:
- show actionable admin diagnostic;
- do not silently install into user storage and defeat lab policy unless policy permits fallback.

---

## 12. Multiple runtime versions

Versioned directories allow:
- semester stability;
- staged upgrades;
- rollback.

Example:
```text
runtime/
├── 2026.1/
└── 2026.2/
```

Machine policy selects active approved version.

---

## 13. Python package policy in labs

Do not let every student mutate the shared Python environment.

Options:
1. standard curated shared package set;
2. project-local virtual environment/cache if administrator permits;
3. custom dependency service later.

No project should run `pip install` into shared read-only Python.

---

## 14. GHDL work isolation

Shared:
```text
ghdl.exe / libraries
```

Per session:
```text
work-obj*.cf
compiled project artifacts
waveforms
VPI temporary/build products
```

Never share project `work` directory among students.

---

## 15. QEMU isolation

Executable may be shared.

Per-session:
- process;
- pipes;
- images/temporary files;
- state.

---

## 16. Storage cleanup

Per-session temporary directories:
- deleted on clean shutdown where safe;
- stale cleanup on next activation;
- do not delete project files;
- bounded retention of crash logs.

Shared runtime caches:
- administrator-managed.

---

## 17. Lab diagnostics

Admin command:

```text
LasecSimul: Run Shared Host Self-Test
```

Checks:
- runtime root permissions;
- version compatibility;
- Core launch;
- Python launch;
- GHDL launch;
- temp isolation;
- unique IPC;
- write access only where expected.

---

## 18. Acceptance criteria

Thirty user profiles should not imply thirty full copies of Python and GHDL when SharedHost policy is active. Executables can be shared read-only, while all mutable simulation state remains isolated.
