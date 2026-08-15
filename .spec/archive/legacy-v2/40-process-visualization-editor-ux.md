# 40 — Process Visualization Editor UX

**Status:** PLANNED  
**Priority:** After basic template selection in `30`  
**Depends on:** `30`, `31`, `17`  
**Related:** `38`

## 1. Goal

Provide a lightweight editor for configuring process visuals without building a complete SCADA screen designer.

---

## 2. MVP interaction

From component:
- double-click → properties;
- `Visualization` section;
- choose template;
- choose bound value;
- min/max;
- unit;
- numeric label.

No separate editor is required for the very first version.

---

## 3. Advanced lightweight editor

Later command:

```text
Edit Process Visualization
```

Panel layout:

```text
┌──────────────┬────────────────────────┐
│ Bindings     │ Preview                │
│              │                        │
│ tank.fill    │       ┌──────┐         │
│ value.text   │       │██████│         │
│ alarm        │       │██████│         │
│              │       └──────┘         │
├──────────────┴────────────────────────┤
│ Selected binding properties           │
└───────────────────────────────────────┘
```

---

## 4. Preview

Preview uses synthetic slider/test value.

Changing preview MUST NOT modify simulation state.

Controls:
```text
Preview value: [0 ---------- 100]
```

---

## 5. Template chooser

Show:
- icon/thumbnail;
- name;
- channels supported.

Examples:
```text
Tank
Thermometer
Furnace
Valve
Pump
Gauge
Custom SVG
```

---

## 6. Binding editor

Fields:
- source;
- channel;
- input min;
- input max;
- clamp;
- unit/format;
- decimals.

Optional:
- transform invert;
- visibility threshold.

---

## 7. Custom SVG binding assistant

Steps:
1. choose SVG;
2. sanitize;
3. scan safe element IDs;
4. choose element;
5. choose behavior;
6. preview;
7. save.

---

## 8. Runtime overlay

During simulation:
- optional numeric value;
- status/fault badge;
- no edit controls unless simulation stopped.

---

## 9. Acceptance criteria

A user can configure a Tank animation without editing JSON and can preview the visual mapping before running simulation.
