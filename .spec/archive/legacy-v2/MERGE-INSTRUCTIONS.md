# Merge Instructions — Add-On Specs 30–42

This ZIP is intentionally incremental.

Extract it at the LasecSimul repository root:

```text
LasecSimul/
├── .spec/
│   ├── existing specs 00–29
│   ├── 30-animated-process-visualization.md
│   ├── ...
│   └── 42-architecture-decisions-addendum.md
├── core/
├── extension/
└── ...
```

It does not overwrite the original numbered specs.

After extraction:

1. Keep all files `30`–`42`.
2. Optionally merge `README-ADDENDUM-30-42.md` into `.spec/README.md`.
3. Optionally merge `STATUS-ADDENDUM-30-42.md` into `.spec/STATUS.md`.
4. Keep `42-architecture-decisions-addendum.md` or merge its ADRs into `.spec/DECISIONS.md`.
5. Give coding agents only the feature specs needed for the current milestone.

Suggested first implementation prompt inputs:

```text
.spec/22-agent-implementation-rules.md
.spec/02-typed-signals-units-bindings.md
.spec/03-signal-engine-mvp.md
.spec/06-process-block-library.md
.spec/17-ui-ux-canvas-catalog.md
.spec/30-animated-process-visualization.md
.spec/31-process-visual-asset-and-animation-schema.md
```

For Python:

```text
.spec/22-agent-implementation-rules.md
.spec/32-python-script-block.md
.spec/33-python-electrical-and-process-io-bridge.md
.spec/34-python-runtime-security-and-dependencies.md
```

For Marketplace setup:

```text
.spec/22-agent-implementation-rules.md
.spec/35-marketplace-one-click-installation.md
.spec/36-managed-toolchain-bootstrap.md
.spec/37-first-run-onboarding-and-setup-prompt.md
.spec/39-marketplace-release-packaging-and-ci.md
```
