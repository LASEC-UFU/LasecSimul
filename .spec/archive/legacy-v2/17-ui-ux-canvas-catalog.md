# 17 — Unified Canvas, UX, Catalog and Editors

**Status:** PLANNED  
**Priority:** Cross-cutting after headless behavior  
**Depends on:** each feature's Core MVP

## 1. Goal

Maintain one coherent LasecSimul visual environment while introducing new connection types and specialized editors.

## 2. One main engineering canvas

The main schematic supports:

- electrical components;
- signal/control blocks;
- process blocks;
- smart instruments;
- PLC device blocks;
- MCU;
- FPGA;
- protocol devices;
- hybrid subsystems.

Do not create separate project types for “circuit project” and “control project” unless a future hard requirement appears.

## 3. Connection affordances

Electrical:
- existing wire behavior;
- undirected physical semantics.

Signal:
- arrow/direction;
- source/sink validation;
- optional type/unit tooltip.

Protocol link:
- semantic network style later;
- do not visually imitate electrical wiring if it behaves differently.

## 4. Port visuals

A mixed-domain component must clearly distinguish:

- electrical terminal;
- signal input;
- signal output;
- network/protocol endpoint.

Use style tokens/design system rather than hard-coded component-specific colors.

## 5. Palette taxonomy

Candidate:

```text
Electrical
├── Sources
├── Passive
├── Semiconductors
└── Digital

Control & Signals
├── Sources
├── Math
├── Continuous
├── Discrete
├── Nonlinear
└── Sinks

Process
├── Generic Dynamics
└── Equipment

Instrumentation
├── Sensors
├── 4–20 mA
└── HART

Industrial Communication
├── Modbus
└── Monitors

Controllers
├── PLC
├── MCU
└── FPGA
```

Fit to current `folderPath` catalog mechanism rather than inventing a second category engine.

## 6. Double-click behavior

- ordinary block → properties;
- Scope → scope viewer;
- Smart Instrument → instrument/configuration panel;
- Modbus Server → register-map editor;
- Modbus Scanner → scanner panel;
- PLC → PLC project editor;
- FPGA → VHDL source/config panel or command palette actions;
- Subsystem → internal subsystem editor.

## 7. Specialized editors

Use dedicated panels/views where domain semantics differ substantially:

- Ladder editor;
- Modbus register map;
- HART communicator;
- Scope.

Do not force Ladder onto the electrical schematic interaction model.

## 8. Generic symbol/package generation

Reuse existing generic subcircuit package generation for:

- FPGA ports;
- subsystem external ports;
- configurable devices with data-driven pin lists.

Preserve component/pin IDs across regeneration.

## 9. Live values

During simulation, optional overlays:

- signal value;
- engineering unit;
- PLC RUN/FAULT;
- transmitter PV/current/status;
- Modbus client polling status;
- FPGA/GHDL health.

Throttle/batch UI updates. UI repaint must never backpressure simulation unless explicit debug pause mode exists.

## 10. Scope

Scope MVP:
- subscribe to selected signal values;
- bounded ring/history;
- decimated rendering;
- pause/zoom;
- export later.

Electrical oscilloscope and signal Scope may share plotting infrastructure but have different source adapters.

## 11. Diagnostics UX

Surface:

- toast for actionable top-level failure;
- Problems for source/config diagnostics;
- output/log channels for detailed traces;
- inline component badge for faulted device;
- protocol raw trace in dedicated panel.

Avoid flooding notifications for repeated runtime faults.

## 12. Packaging

Every user-facing component needs checks for:

- catalog visibility;
- icon/symbol;
- runtime factory availability;
- packaged assets;
- Windows/Linux path rules where relevant.

Remember previous architecture lesson: palette/catalog inclusion and Core/device library loading are separate concerns.

## 13. Accessibility and keyboard

At minimum:

- keyboard focusable property/editor controls;
- textual labels not color-only state;
- command palette equivalents for major actions;
- zoom independent of text readability where practical.

## 14. Acceptance criteria

A mixed project can be created without the user being confused about whether a connection is electrical or a signal, and specialized device editors remain visually integrated with LasecSimul.
