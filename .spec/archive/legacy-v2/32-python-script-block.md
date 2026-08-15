# 32 — Python Script Block

**Status:** NOT STARTED  
**Priority:** High after Signal Engine MVP  
**Depends on:** `01`, `02`, `03`, `04`, `05`, `18`, `24`  
**Related:** `33`, `34`, `38`, `41`

## 1. Goal

Allow the user to write Python code in VS Code and use that code as a LasecSimul simulation component.

The Python component must work in two domains:

1. **process/signal domain**;
2. **electrical/circuit domain through controlled electrical adapters**.

The user must never need to modify the C++ Core to create a custom educational or process model.

---

## 2. Fundamental safety/architecture rule

Python code MUST NOT directly manipulate:
- the MNA matrix;
- raw solver pointers;
- Scheduler internals;
- Netlist memory;
- Core memory.

Instead:

```text
Python user code
   ↕ versioned message API
Python runtime bridge
   ↕ typed block contract
Fpga-like/Mcu-like external participant controller
   ↓
normal LasecSimul component interfaces
```

For circuit interaction:

```text
Python result
   ↓
Electrical adapter implemented in Core
   ↓
stamp(MnaMatrixView&)
```

The C++ component remains responsible for all electrical stamping.

---

## 3. User experience

User places:

```text
Control & Signals
└── Python Block

Electrical
└── Python Device
```

or a single configurable `Python Block` with domain mode.

Recommended MVP has two palette entries sharing one runtime backend:

- `Python Signal Block`
- `Python Electrical Device`

This makes connection semantics obvious.

---

## 4. Source-file workflow

User code resides in a normal `.py` file in the project/workspace.

Example:

```text
project/
├── plant.lsproj
├── scripts/
│   └── custom_process.py
└── ...
```

Project stores:

```text
scripts/custom_process.py
```

as a relative path.

VS Code remains the code editor.

---

## 5. Signal-block contract

Recommended Python source contract:

```python
def init(ctx):
    return {
        "x": 0.0
    }

def step(ctx, inputs, state):
    u = float(inputs["u"])
    dt = ctx["dt"]
    tau = 5.0

    state["x"] += dt * ((u - state["x"]) / tau)

    return {
        "outputs": {
            "y": state["x"]
        },
        "state": state
    }

def reset(ctx, state):
    return state

def finalize(ctx, state):
    pass
```

The final API may use dataclasses/helpers, but the wire protocol must remain language/runtime independent.

---

## 6. Context object

MVP context should expose only necessary deterministic data:

```text
time
dt
instanceId
stepIndex
samplePeriod
parameters
```

Optional later:
- event reason;
- quality/status;
- deterministic RNG seed.

Do not expose wall-clock time as simulation time.

---

## 7. Ports

Python block properties:

```text
Inputs
  u: float [optional unit]
  enable: bool

Outputs
  y: float [optional unit]
  alarm: bool
```

Port definitions SHOULD be explicit and persisted.

The runtime does not infer stable project topology from arbitrary Python dictionary keys on every call.

Possible editor UI:
- Add Input;
- Add Output;
- name;
- type;
- unit;
- default;
- direction.

Dynamic pin mechanisms from existing component architecture SHOULD be reused.

---

## 8. Supported signal types MVP

At minimum:

```text
float64
bool
int32/int64
```

Optional shortly after:
```text
string for diagnostics/HMI only
float vector
```

Avoid arbitrary Python objects crossing the simulation boundary.

---

## 9. Scheduling modes

### 9.1 Discrete periodic

Primary MVP mode:

```text
samplePeriod = user-defined
```

Scheduler invokes Python at scheduled simulation times.

Recommended for:
- control algorithms;
- custom process models;
- logic;
- filters;
- observers;
- educational equations.

### 9.2 Event-triggered

Later/optional:
- run when input changes;
- coalesce same-time changes;
- deterministic ordering.

### 9.3 Continuous algebraic callback

NOT MVP.

Do not call Python inside every Newton iteration of the MNA solver.

That would create severe determinism/performance/reentrancy risks.

---

## 10. State lifecycle

Per component instance:

```text
create
  ↓
load source
  ↓
init()
  ↓
step()...
  ↓
reset() on simulation reset
  ↓
finalize()
  ↓
destroy
```

Restarting simulation must recreate or explicitly reset script state according to a defined policy.

Default:
- fresh state on new run;
- persisted component parameters remain;
- runtime state is not saved into `.lsproj` unless a future snapshot feature requires it.

---

## 11. Error behavior

Compile/import error:
- block does not start;
- diagnostic in VS Code Problems;
- simulation start may fail if block is required.

Runtime exception:
- catch at runtime boundary;
- mark component `Faulted`;
- show traceback in LasecSimul output;
- Problems should point to file/line where available;
- Core must not crash.

Configurable future policy:
- stop entire simulation;
- hold last output;
- output safe defaults.

MVP preferred:
- stop/pause simulation with a clear actionable error for deterministic teaching behavior.

---

## 12. Reload workflow

User edits `.py`.

Recommended:
- while stopped: next Run loads latest source;
- command: `LasecSimul: Reload Python Models`;
- during RUN: do not silently hot-reload by default.

Future hot-reload may be offered with explicit reset semantics.

---

## 13. Parameters

User parameters are configured separately from code:

```text
tau = 5.0
gain = 2.0
```

Python receives:

```python
ctx["parameters"]["tau"]
```

This allows one script file to back multiple component instances.

---

## 14. Example — custom first-order process

```python
def init(ctx):
    return {"y": 0.0}

def step(ctx, inputs, state):
    u = inputs["u"]
    K = ctx["parameters"].get("K", 1.0)
    tau = ctx["parameters"].get("tau", 5.0)
    state["y"] += ctx["dt"] * ((K*u - state["y"]) / tau)
    return {"outputs": {"y": state["y"]}, "state": state}
```

Canvas:

```text
Step ─► Python Process ─► Scope
```

---

## 15. Example — nonlinear tank

```python
import math

def init(ctx):
    return {"h": 0.0}

def step(ctx, inputs, state):
    qin = max(0.0, inputs["qin"])
    A = ctx["parameters"]["A"]
    C = ctx["parameters"]["C"]

    h = max(0.0, state["h"])
    qout = C * math.sqrt(h)

    h += ctx["dt"] * (qin - qout) / A
    h = max(0.0, h)

    state["h"] = h
    return {
        "outputs": {
            "level": h,
            "qout": qout
        },
        "state": state
    }
```

This can be combined with spec `30` to display a Tank animation.

---

## 16. Determinism

Python block results should be reproducible given:
- same source;
- same parameters;
- same inputs;
- same scheduling;
- same supported runtime version.

Disallow/flag nondeterministic sources in “deterministic mode” where feasible:
- wall clock;
- uncontrolled random;
- network;
- subprocesses.

Full sandboxing is covered by spec `34`.

---

## 17. Performance

The architecture must avoid:
- launching Python for every step;
- importing script on every call;
- serializing entire project state;
- per-block operating-system process unless isolation mode specifically requests it.

Preferred:
- one managed Python worker process per SimulationSession;
- multiple isolated component contexts inside worker;
- persistent imports/state;
- batched calls where possible.

---

## 18. Project persistence

Persist:
- Python source relative path;
- port definitions;
- parameters;
- scheduling mode;
- sample period;
- safe-output/error policy;
- runtime environment selection if future multiple environments exist.

Do not embed source code in `.lsproj` by default.

---

## 19. Diagnostics

Surface:
- Python not installed/runtime missing;
- environment corrupt;
- syntax error;
- import error;
- missing function;
- invalid output schema;
- timeout;
- process crash;
- type mismatch;
- invalid unit;
- NaN/Inf output.

---

## 20. Acceptance criteria — signal domain

A user can create `custom_process.py`, configure one input and one output, connect:

```text
Step → Python Block → Scope
```

and obtain deterministic output using LasecSimul simulation time.

---

## 21. Acceptance criteria — circuit domain

See spec `33` for exact electrical adapter.

A user can read a circuit voltage and drive a supported electrical output through the Python device without Python accessing MNA internals.
