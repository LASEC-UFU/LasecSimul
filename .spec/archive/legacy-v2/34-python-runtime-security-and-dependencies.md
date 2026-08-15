# 34 — Python Runtime, Security, Isolation and Dependencies

**Status:** NOT STARTED  
**Priority:** Mandatory before publishing Python blocks broadly  
**Depends on:** `18`, `32`, `33`, `35`, `36`  
**Related:** VS Code Workspace Trust

## 1. Goal

Provide a managed Python runtime for LasecSimul that:
- requires no manual Python installation for the normal user;
- cannot crash the Core directly;
- respects VS Code Workspace Trust;
- has explicit dependency management;
- produces clear diagnostics.

---

## 2. Preferred MVP runtime architecture

Use an external worker process:

```text
LasecSimul Core
    ↓
PythonProcessManager
    ↓
Python Worker
    ↓
user .py modules
```

Do NOT embed CPython into the Core for the first implementation.

Reasons:
- process isolation;
- simpler crash recovery;
- easier runtime replacement/update;
- no Python ABI inside Core process;
- easier timeout management.

---

## 3. Runtime ownership

Core owns the Python worker lifecycle because Core owns simulation.

The Webview/Extension MUST NOT become the simulation runtime.

Candidate:

```text
SimulationSession
  └── PythonRuntimeController
        └── PythonProcessManager
              └── worker process
```

Names are candidates; inspect repository first.

---

## 4. Managed runtime

Marketplace/bootstrap design should provide a known Python runtime.

Preferred model is resolved by `RuntimeResolver`.

Personal Desktop may use:

```text
<user-managed-runtime>/python/<version>/<platform>/
```

SharedHost should use a machine-level read-only runtime provisioned once for all students.

LasecSimul invokes the resolved interpreter by absolute path.

Do not:
- modify global PATH;
- require administrator privileges;
- overwrite system Python;
- depend on whichever `python` happens to be first in PATH.

Optional setting may allow advanced users to choose system Python later.

---

## 5. Environment versioning

Record:

```text
python runtime version
worker protocol version
standard library version
LasecSimul runtime bundle version
dependency lock hash
```

A project may optionally declare compatibility constraints in the future.

---

## 6. Default dependency policy

MVP runtime SHOULD include:
- Python standard library;
- a very small documented set of approved packages only if needed.

Avoid shipping a huge scientific distribution initially unless actual use cases require it.

Candidate optional package set:
- numpy, only after performance/size/license review.

A basic process model should not require NumPy.

---

## 7. Project dependencies

Future controlled mechanism:

```text
lasecsimul-python.lock
```

or project metadata listing allowed Python packages.

Do not execute arbitrary `pip install` silently.

Recommended workflow:
1. user asks to add package;
2. LasecSimul shows package/version/source;
3. user confirms;
4. install into project/runtime environment;
5. lock exact version;
6. display diagnostics if unavailable.

---

## 8. Workspace Trust

Python source from the workspace is executable code.

Therefore:
- Python simulation features MUST be disabled or limited in untrusted workspaces;
- use VS Code Workspace Trust support;
- do not auto-run user `.py` files merely because project opened;
- Run command must validate trust before execution.

Extension can still allow safe browsing/editing/configuration in Restricted Mode.

---

## 9. OS-level sandbox reality

A Python child process is isolation from Core crashes, but NOT a complete security sandbox.

Do not falsely claim that ordinary child-process isolation prevents:
- file access;
- network access;
- process spawning.

If strong sandboxing is later required, implement OS-specific containment explicitly.

MVP security posture:
- require trusted workspace;
- explicit user action to simulate;
- managed runtime;
- clear warning that Python block executes project code;
- child-process crash isolation;
- optional restricted API policy.

---

## 10. Restricted API mode

Optional educational mode may patch/limit obvious dangerous modules, but this is not a security boundary.

Potential policy:
- network disabled by convention;
- subprocess disabled;
- file writes outside project/runtime discouraged.

Do not call it a secure sandbox unless enforced by OS/container mechanisms.

---

## 11. Worker protocol

Use a versioned protocol.

Example messages:

```text
hello
loadInstance
initialize
step
reset
finalize
unloadInstance
ping
shutdown
```

Every message includes:
- protocol version;
- request ID;
- instance ID where relevant.

---

## 12. Transport

MVP candidates:
- existing IPC utilities if reusable;
- stdin/stdout framed JSON;
- local named pipe/socket.

Favor minimal architecture reuse.

Do not create shared memory unless profiling proves JSON/framed IPC is insufficient.

---

## 13. Timeouts

Worker calls need configurable wall-clock watchdogs.

Example:
- `step` allowed max wall duration;
- timeout marks script faulted;
- process may be terminated/restarted.

This wall-clock timeout is a runtime safety mechanism, not simulation time.

---

## 14. Crash recovery

If worker crashes:
1. detect exit;
2. mark Python participants faulted;
3. pause/stop simulation safely;
4. preserve logs;
5. offer restart;
6. reinitialize all instances on next run.

Do not attempt to continue with unknown Python state.

---

## 15. stdout/stderr

User `print()`:
- route to `LasecSimul Python` output channel;
- tag component instance;
- rate limit pathological output.

stderr/tracebacks:
- capture completely enough for diagnosis;
- parse source line when possible;
- publish Problems diagnostic.

---

## 16. File resolution

Script source:
- project-relative path preferred;
- canonicalize;
- reject escaping project boundaries in normal mode unless explicitly allowed;
- handle Windows/Linux separators.

Imports:
- project `scripts/` path can be added intentionally;
- managed runtime library path;
- do not accidentally inherit arbitrary user site-packages in deterministic managed mode.

---

## 17. Reproducibility

Managed mode should set:
- controlled `PYTHONPATH`;
- no user site packages;
- known interpreter;
- known environment;
- stable worker code.

Expose runtime info in diagnostics.

---

## 18. Tests

- runtime missing;
- runtime version mismatch;
- worker handshake;
- syntax error;
- import error;
- timeout;
- crash;
- restart;
- stdout/stderr;
- path traversal rejection;
- untrusted workspace gating;
- deterministic environment;
- multiple Python block instances;
- large number of small steps;
- graceful shutdown.

---

## 19. Acceptance criteria

A fresh LasecSimul installation can execute a trusted project's Python block without requiring a system Python installation, while a broken or crashing script cannot crash the native Core process directly.
## 20. Multiuser laboratory constraints

SharedHost default:
- one Python worker process per SimulationSession, not per block;
- worker uses shared read-only interpreter/runtime;
- each session has private script state/cache/temp;
- no project may mutate shared Python installation;
- dependency installation into shared runtime is administrator-controlled.

Python worker startup is lazy:
```text
project has no Python Block → no Python process
```

See specs `43`, `44`, `45`.
