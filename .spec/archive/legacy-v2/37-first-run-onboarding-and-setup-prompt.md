# 37 — First-Run Onboarding and Setup Prompt

**Status:** NOT STARTED  
**Priority:** Release-critical UX  
**Depends on:** `35`, `36`  
**Related:** `17`, `18`

## 1. Goal

Provide one clear first-run interaction after Marketplace installation.

The user requested a workflow where the Marketplace package “downloads, calls a prompt, and installs everything it uses”.

This spec defines that prompt and the follow-up setup experience.

---

## 2. First-run trigger

Show setup prompt when:
- extension is activated;
- required runtime inventory is incomplete;
- setup has not been intentionally postponed for current runtime version.

Do not show on every activation after successful setup.

---

## 3. Prompt copy proposal

```text
Prepare LasecSimul?

LasecSimul needs to install its local simulation runtime and optional toolchains
used by features such as Python Blocks and VHDL/FPGA simulation.

The components are stored in VS Code extension storage.
No administrator access or system PATH changes are required.

[Install Recommended Components] [Choose Components] [Later]
```

Actual localization should use package localization files.

---

## 4. Recommended-components selection

Default checked:

```text
[x] LasecSimul Core/runtime essentials
[x] Python runtime
[x] GHDL / VHDL runtime
[x] Process visualization assets
[x] Examples
```

Only list separately if not already bundled.

Provide estimated download size.

---

## 5. Choose Components

Advanced dialog:

```text
Required
  [x] Core essentials

Simulation Features
  [x] Python Blocks
  [x] FPGA / VHDL (GHDL)

Content
  [x] Example projects

Optional Editor Support
  [ ] Recommended Python editor extension
  [ ] Recommended VHDL editor extension
```

Do not confuse editor extensions with runtime dependencies.

---

## 6. Progress

Use a VS Code progress UI plus optional Setup Center details.

Stages:
```text
Checking
Downloading
Verifying
Extracting
Testing
Ready
```

Report the current component.

---

## 7. Completion

Success:

```text
LasecSimul is ready.

[Open Examples] [Create Project] [Check Installation]
```

Optionally show:
- installed versions;
- runtime root.

---

## 8. Failure

Example:

```text
Python runtime could not be installed.
The rest of LasecSimul is ready.

[Retry Python] [Open Setup Center] [View Log]
```

Do not block unrelated features if only an optional runtime fails.

---

## 9. Deferred setup

If user chooses Later:
- basic extension UI may load;
- commands requiring missing runtime trigger Setup Center;
- avoid repeated modal nags;
- show unobtrusive status item when appropriate.

---

## 10. Feature-triggered setup

If Python runtime was skipped and user adds a Python Block:

```text
Python Blocks require the LasecSimul Python runtime.

[Install Python Runtime] [Cancel]
```

Same concept for GHDL.

---

## 11. Workspace Trust prompt ordering

Do not conflate:
- trusting the LasecSimul publisher;
- runtime setup;
- trusting project code.

Managed runtimes may be installed before workspace trust, but Python/VHDL project execution must obey the relevant trust policy.

---

## 12. Lab mode

Add setting/administrative option:

```text
lasecsimul.setup.suppressFirstRunPrompt
```

for pre-provisioned classrooms.

A lab image can install runtime bundle before students launch VS Code.

---

## 13. Accessibility

Prompt and Setup Center:
- keyboard accessible;
- not color-only;
- clear progress labels;
- screen-reader labels;
- errors have text.

---

## 14. Acceptance criteria

A first-time user understands what will be downloaded, confirms once, sees progress, and reaches a working LasecSimul environment without manually opening a terminal.
## 15. Deployment question

After/within initial setup, ask only when no administrator policy already defines the environment:

```text
Choose deployment profile

● Automatic — Recommended
○ Personal computer / workstation
○ Shared laboratory / thin-client host
○ Advanced
```

This does not select a different executable or simulation engine.

It configures:
- runtime storage strategy;
- resource policy;
- default UI/telemetry limits;
- shared-host isolation behavior.

---

## 16. SharedHost administrator experience

For a lab host, the preferred flow is administrator provisioning rather than every student answering setup questions.

Admin:
```text
install extension/runtime bundle
→ select SharedHost
→ run host self-test
→ publish machine policy
```

Students:
```text
sign in/open VS Code
→ LasecSimul detects healthy managed environment
→ ready
```

---

## 17. Wording

Avoid calling SharedHost profile "Client/Server" in the UI.

Use:
```text
Shared laboratory / thin-client host
```

Reserve `Remote simulation server` for the future spec `48`.
