# 35 — Marketplace One-Click Installation

**Status:** NOT STARTED  
**Priority:** Release-critical  
**Depends on:** current extension packaging, `36`, `37`, `39`  
**Related:** all external runtimes including GHDL and Python

## 1. Goal

The normal user experience must be:

```text
VS Code Marketplace
        ↓
Install LasecSimul
        ↓
one first-run setup prompt
        ↓
LasecSimul prepares everything it needs
        ↓
Ready
```

The user SHOULD NOT need to manually install:
- LasecSimul Core;
- device libraries;
- Python runtime used by Python Blocks;
- GHDL used by VHDL/FPGA, when the feature is enabled/supported;
- runtime helper processes;
- default assets/examples needed by the installed feature set.

---

## 2. VS Code packaging facts guiding the design

Current VS Code supports:
- Marketplace installation of extensions;
- platform-specific extension packages;
- extension dependencies and extension packs for other extensions;
- extension-owned global storage for large runtime data.

LasecSimul is a desktop/workspace extension because it launches native processes.

A pure VS Code Web extension cannot launch native executables, so full LasecSimul simulation is not a vscode.dev-only feature.

---

## 3. Recommended distribution architecture

Publish one LasecSimul extension ID with platform-specific packages.

Target matrix initially:

```text
win32-x64
linux-x64
```

Then as supported:

```text
win32-arm64
linux-arm64
darwin-x64
darwin-arm64
```

Do not claim platform support until CI validates that runtime.

---

## 4. What is bundled in the VSIX

Bundle items that are:
- small enough;
- license-compatible;
- tightly coupled to extension version;
- needed to start bootstrap safely.

Recommended bundled:

```text
extension JS bundle
icons/assets
schemas
default catalog/device descriptors
platform-native LasecSimul Core
bootstrap manager
dependency manifest
download verifier
Python worker bootstrap code
built-in process visualization SVGs
basic examples/templates if size permits
```

---

## 5. What may be downloaded after installation

Large third-party toolchains MAY be provisioned on first run:

```text
managed Python runtime
GHDL distribution
optional VHDL helper tools
future protocol/runtime helpers
```

This allows Marketplace package size to stay manageable and enables independent runtime patching.

However, the user experience must still be one guided installation.

---

## 6. First activation flow

Pseudo-flow:

```text
activate extension
   ↓
detect platform/architecture
   ↓
load bundled dependency manifest
   ↓
check installed runtime inventory
   ↓
if complete → activate normally
   ↓
if incomplete → show first-run prompt
```

Prompt example:

```text
LasecSimul needs to prepare its local simulation environment.
Required components will be installed in VS Code's extension storage.
No administrator access or system PATH changes are required.

[Install Now] [View Components] [Later]
```

Do not download/execute third-party runtimes silently without a user-visible setup action.

---

## 7. Setup Center

After `Install Now`, show a small Setup Center:

```text
LasecSimul Core              Ready
Default device library       Ready
Python Runtime               Installing...
GHDL                         Pending
Process visual assets        Ready

Overall                      62 %
```

Provide:
- status;
- version;
- source/license info;
- bytes downloaded;
- retry;
- cancel where safe;
- diagnostic details.

---

## 8. Installation location

Use extension-managed storage, preferably based on VS Code `globalStorageUri`.

Conceptual:

```text
<globalStorage>/
└── runtime/
    ├── core/
    ├── python/
    ├── ghdl/
    ├── tools/
    ├── cache/
    └── manifests/
```

Do not put downloaded toolchains into the user workspace by default.

---

## 9. No administrator privileges

Normal setup MUST NOT require:
- UAC/admin;
- sudo;
- registry system modifications;
- machine-wide PATH edits.

Invoke all managed tools by absolute path.

---

## 10. Dependency modes

### Standard mode

Install all recommended runtime dependencies in one prompt.

### Minimal mode

Install only Core essentials; feature runtimes downloaded on first feature use.

### Offline/Lab mode

Provide a full VSIX or offline runtime bundle that can be distributed in a laboratory without internet.

The normal Marketplace path should default to Standard mode if size/download policy is acceptable.

---

## 11. Feature dependency mapping

Example:

```text
Core simulation
  └── bundled native Core

Python Blocks
  └── managed Python runtime

FPGA/VHDL
  └── managed GHDL

Process animation
  └── bundled SVG/render assets

PLC/Modbus/HART
  └── normally Core/native components, no external runtime initially
```

---

## 12. Required commands

```text
LasecSimul: Setup
LasecSimul: Check Installation
LasecSimul: Repair Installation
LasecSimul: Show Runtime Versions
LasecSimul: Open Setup Log
LasecSimul: Remove Downloaded Runtimes
```

Optional:
```text
LasecSimul: Download Offline Bundle
```

---

## 13. Runtime resolution priority

For each tool:

```text
1. explicitly configured user path
2. LasecSimul managed runtime
3. system PATH fallback, only if permitted
4. missing → setup/diagnostic
```

For deterministic default installations, managed runtime should be preferred over system PATH.

---

## 14. Existing settings compatibility

If current project already has settings like:

```text
lasecsimul.fpga.ghdlPath
```

preserve them.

Add:

```text
lasecsimul.runtime.mode
lasecsimul.runtime.root
lasecsimul.python.executablePath
lasecsimul.setup.autoCheck
```

Do not proliferate settings unnecessarily.

---

## 15. Extension dependencies vs runtime dependencies

Distinguish:

```text
VS Code extension dependency
```

from:

```text
native/runtime dependency
```

Python Block execution does NOT require the Microsoft Python extension.

VHDL simulation does NOT require a third-party VHDL editor extension.

Those may be offered as optional recommendations, but LasecSimul runtime functionality should not depend on them unless intentionally designed.

---

## 16. Workspace Trust

First-run runtime setup is extension-level.

Execution of workspace code, especially:
- Python scripts;
- project-configured external executables;

must respect Workspace Trust.

Do not automatically execute project code immediately after installing the extension.

---

## 17. Remote/WSL/SSH considerations

LasecSimul should declare appropriate extension execution location.

A workspace extension runs where the workspace is located.

Therefore the bootstrapper must install/use runtime for the actual host environment where the Core executes.

Do not reuse a Windows runtime path inside Linux/WSL.

Runtime key should include:

```text
os
architecture
libc where relevant
runtime version
```

---

## 18. Web VS Code

Full simulation requires native executables/processes.

Therefore:
- vscode.dev/browser-only mode may provide limited project browsing/editing;
- simulation commands should explain unsupported environment;
- do not attempt to fake native simulation in a browser.

---

## 19. Update behavior

Extension update:
1. activate new extension version;
2. compare runtime manifest;
3. reuse compatible runtimes;
4. download only missing/incompatible components;
5. keep previous known-good runtime until replacement verified.

Never delete the working runtime before the new one passes validation.

---

## 20. Repair behavior

`Check Installation` verifies:
- file existence;
- executable launch;
- version;
- checksum/inventory;
- Core handshake;
- Python worker handshake;
- GHDL `--version` or equivalent supported probe.

`Repair Installation` downloads/replaces only failed items.

---

## 21. Uninstall behavior

VS Code extension removal may not always be the right moment for destructive cleanup.

Provide explicit command to remove downloaded runtimes/cache.

Document storage location.

Do not delete user projects.

---

## 22. Telemetry/privacy

If telemetry exists, it must be explicit and follow project policy.

Runtime setup logs should avoid:
- user source code;
- credentials;
- unrelated filesystem contents.

---

## 23. Failure UX

Examples:

```text
Download failed
Checksum mismatch
Unsupported CPU
GHDL package unavailable
Python runtime extraction failed
Core self-test failed
Proxy/network issue
Disk space insufficient
```

Each needs:
- human-readable message;
- technical details in output;
- retry action;
- link/command to Setup Center.

---

## 24. Acceptance criteria

On a clean supported desktop with VS Code installed, a user installs LasecSimul from Marketplace, accepts one setup prompt, and can run:
- a basic circuit;
- a process example;
- a Python Block;
- an FPGA/VHDL example if that runtime is selected/supported,

without manually installing Python, GHDL, or editing PATH.
## 25. Deployment profile selection

The installation/setup flow does **not** install a different simulator for Desktop and Shared Host.

It configures one architecture with a deployment profile:

```text
How will LasecSimul normally be used on this computer?

● Automatic — Recommended
○ Personal computer / workstation
○ Shared laboratory / thin-client host
○ Advanced / custom
```

`Automatic` is the normal default.

If an administrator has already provisioned a machine-wide policy, the setup SHOULD honor it and avoid asking ordinary students.

### Personal computer

Default runtime location:
- extension/user managed storage;
- normal Desktop resource budget.

### Shared laboratory / thin-client host

Preferred:
- shared read-only toolchain/runtime installed once by administrator;
- per-user/per-session mutable state;
- conservative ResourceGovernor defaults;
- virtual network isolation;
- no repeated large runtime downloads per student.

This is still `LocalSimulationBackend`: Core executes on the same shared host session.

### Future remote/server

Do not expose this as a normal installation choice until `RemoteSimulationBackend` exists.

The current SharedHost profile must not be mislabeled as true client/server.

---

## 26. RuntimeResolver integration

All tools are resolved through the same runtime service.

Conceptual priority:

```text
explicit approved override
shared runtime when machine policy configures it
user managed runtime
bundled runtime
optional system fallback if policy permits
```

No Python/GHDL-specific installer should independently search and mutate PATH.

---

## 27. SharedHost first-run behavior

If machine policy says SharedHost and the shared runtime is healthy:

```text
extension activates
→ validates host runtime
→ creates private session storage
→ ready
```

No Python/GHDL redownload into each user's VS Code storage.

If shared runtime is incomplete:
- present an administrator-oriented diagnostic;
- do not silently duplicate a multi-gigabyte runtime per student unless the policy explicitly allows a fallback.

See `45-shared-runtime-laboratory-deployment.md`.
