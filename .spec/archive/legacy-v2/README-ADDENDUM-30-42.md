# README Addendum — Specs 30–42

This file is an addendum for the existing `.spec/README.md`.

## New feature group

### Animated process visualization

Read:
- `30-animated-process-visualization.md`
- `31-process-visual-asset-and-animation-schema.md`
- `40-process-visualization-editor-ux.md`

Use when implementing simple SCADA-like graphics for:
- tanks;
- temperature;
- flame;
- valves;
- pumps;
- gauges.

### Python simulation blocks

Read:
- `32-python-script-block.md`
- `33-python-electrical-and-process-io-bridge.md`
- `34-python-runtime-security-and-dependencies.md`
- `38-animated-process-python-integration.md`

### Marketplace/one-click setup

Read:
- `35-marketplace-one-click-installation.md`
- `36-managed-toolchain-bootstrap.md`
- `37-first-run-onboarding-and-setup-prompt.md`
- `39-marketplace-release-packaging-and-ci.md`

### Validation

Read:
- `41-new-feature-test-matrix-and-demos.md`
- `42-architecture-decisions-addendum.md`

## Recommended implementation order

```text
30 + 31
  ↓
simple Tank/Temperature animation

32
  ↓
Python Signal Block

34
  ↓
managed Python worker

33
  ↓
Python Electrical Device

38
  ↓
Python process + animated Tank

35 + 36 + 37
  ↓
one-click Marketplace setup

39 + 41
  ↓
release/CI hardening

40
  ↓
visualization editor improvements
```

Do not attempt all files in one coding-agent session.
