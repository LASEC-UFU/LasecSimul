# 31 — Process Visual Asset and Animation Schema

**Status:** NOT STARTED  
**Priority:** High with spec `30`  
**Depends on:** `16`, `17`, `30`  
**Related:** `07`, `21`, `38`

## 1. Goal

Define a safe, data-driven asset format for simple animated process graphics.

The format must support built-in and project-local visual assets while preserving the LasecSimul single-source/catalog philosophy.

---

## 2. Design principles

1. Prefer SVG for animated process graphics.
2. Do not execute scripts from SVG.
3. Bind semantic channels to named SVG elements.
4. Keep simulation model and rendering asset independent.
5. Preserve compatibility with normal static component symbols.
6. Use project-relative paths for project assets.
7. Built-in templates must be packaged with the extension.
8. A broken asset must never break the simulation.

---

## 3. Proposed descriptor

Candidate field in `.lsdevice` or equivalent canonical device descriptor:

```json
{
  "visualization": {
    "kind": "process-svg",
    "asset": "assets/tank.svg",
    "viewBox": "0 0 200 240",
    "channels": {
      "tank.fill": {
        "elementId": "liquid",
        "behavior": "liquid-level"
      },
      "value.text": {
        "elementId": "valueText",
        "behavior": "text"
      }
    }
  }
}
```

If the current `.lsdevice` schema cannot safely accept this field, update the schema intentionally and backward-compatibly.

Do not add a parallel `.lsvisual` file unless implementation evidence proves it necessary.

---

## 4. Built-in template library

Initial assets:

```text
assets/process/
├── tank.svg
├── vessel.svg
├── thermometer.svg
├── heater.svg
├── furnace.svg
├── flame.svg
├── valve.svg
├── pump.svg
├── fan.svg
├── gauge.svg
└── indicator.svg
```

Keep visual style coherent with LasecSimul.

---

## 5. Required element conventions

Example Tank SVG logical IDs:

```text
body
liquidClip
liquid
inletPipe
outletPipe
valueText
unitText
alarmIndicator
```

The renderer MUST not depend on brittle DOM traversal.

Use explicit IDs referenced by the descriptor.

---

## 6. Liquid-level behavior

Recommended renderer semantics:

```text
normalized = clamp(value, 0, 1)
visibleHeight = containerHeight * normalized
y = bottom - visibleHeight
```

The liquid graphic grows from bottom to top.

The SVG template should expose:
- liquid region;
- clipping region or a transformable liquid rectangle;
- vessel body.

---

## 7. Temperature behavior

MVP preferred:
- height/fill mapping;
- optional text.

Avoid using color as the sole information channel.

A later enhancement may support color interpolation, but text or geometry MUST still communicate the value.

---

## 8. Flame behavior

Input normalized to `0..1`.

Possible mapping:

```text
scaleY = 0.2 + 0.8 * intensity
opacity = 0.2 + 0.8 * intensity
```

Optional flicker:
- deterministic;
- small amplitude;
- purely decorative.

No random UI effect may be fed back into simulation.

---

## 9. Rotation behavior

For pump/fan/motor:

```text
angle(t) = phase + omegaVisual * simulationTime
```

Where `omegaVisual` is derived from a bound value.

The UI may cap apparent visual speed to avoid aliasing.

---

## 10. Valve-position behavior

Map `0..100%` to:
- stem translation;
- disc rotation;
- or fill/position indicator.

The underlying valve process model remains separate.

---

## 11. Status classes

Optional state binding:

```text
normal
warning
alarm
fault
off
active
```

The renderer maps these semantic states to design tokens.

Do not hard-code CSS names into Core simulation code.

---

## 12. Custom SVG support

A user MAY select a project-local SVG.

Requirements:
- copy/reference asset inside project;
- use relative path;
- sanitize before rendering;
- disallow executable content;
- disallow external network references;
- disallow event handler attributes;
- disallow `<script>`;
- disallow unsafe `<foreignObject>` in MVP;
- reject unsupported features with diagnostics.

The original file may remain untouched; the extension can create a sanitized cached representation.

---

## 13. Custom binding setup

MVP UI for custom SVG may provide:

```text
Asset: ./assets/my-tank.svg
Channel: tank.fill
Element ID: liquid
Behavior: liquid-level
Input source: output.y
Input min: 0
Input max: 10
```

Do not require the user to edit raw JSON for basic usage.

---

## 14. Image formats

SVG:
- preferred;
- supports element-level animation.

PNG/JPEG:
- allowed only as static background in MVP;
- animation may be overlaid by built-in renderer primitives.

GIF:
- not recommended for process-state animation;
- cannot guarantee state synchronization.

---

## 15. Asset security

Treat project-local visual assets as untrusted content.

Sanitization MUST occur before insertion into a Webview.

Never enable:
- inline JavaScript;
- remote script URLs;
- remote stylesheets;
- Webview escape paths.

Use Webview content-security policy consistent with current extension security patterns.

---

## 16. Renderer isolation

Renderer receives a compact state object such as:

```json
{
  "componentId": "P1",
  "revision": 42,
  "channels": {
    "tank.fill": 0.72,
    "value.text": "3.60 m"
  }
}
```

It does not need the full project or solver state.

---

## 17. Update batching

Preferred:

```text
many Core state changes
      ↓
Extension coalesces
      ↓
one render batch
      ↓
multiple components updated
```

Use component revision/version to discard stale UI state if needed.

---

## 18. Versioning

Descriptor should have explicit version if it becomes independently persisted:

```text
visualization.schemaVersion = 1
```

Unknown future fields should be ignored where safe.

Unknown behavior types should:
- show fallback;
- emit diagnostic;
- not crash the project.

---

## 19. Tests

- SVG sanitizer;
- missing element ID;
- unknown channel;
- invalid behavior;
- static fallback;
- project-relative asset persistence;
- packaged built-in asset path;
- Windows/Linux path normalization;
- malformed SVG;
- huge SVG rejection/limit if needed;
- CSP/unsafe script rejection.

---

## 20. Acceptance criteria

A built-in Tank SVG and a custom safe SVG can both be bound to a simulated output without executing arbitrary script and without changing the simulation result.
