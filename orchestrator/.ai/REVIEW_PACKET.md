# REVIEW PACKET - Iteration 87

DECISION_REQUIRED
The accepted CPython 3.8.10 Burn layout lacks the exact base `core.msi`,
`exe.msi`, and `lib.msi` required by the approved assembly. May the executor
obtain/process those exact signed 3.8.10 MSIs from a new explicitly approved
provenance boundary, or must the accepted-layout-only route be abandoned?

CURRENT_CLASSIFICATION
INFRASTRUCTURE INPUT BOUNDARY UNRESOLVED. CPython 3.8.10 installer and Burn
layout provenance are proven. ESP32_MWDT_BEHAVIOR remains open; no root cause
or semantic production change is declared.

NEW_EVIDENCE
E093: before any MSI/CAB processing, the executor inspected
`orchestrator/.ai/python38_layout_86_20260901T072000/inventory.json` and the
Burn log. The layout has the installer, `core/exe/lib` `_d` and `_pdb` MSI
payloads, other debug payloads, and inventory/log files, but no base
`core.msi`, `exe.msi`, or `lib.msi`. The Burn log records the base packages as
absent and only the `_d`/`_pdb` payloads as acquired. Exact-name homonyms exist
only under `orchestrator/.ai/python310_payloads_74/` and are CPython 3.10;
they were rejected and not opened.

SOURCE_PROOF
`orchestrator/.ai/python38_layout_86_20260901T072000/inventory.json` lists all
13 layout files and none of the three required base MSIs.
`.../burn_layout.log` lines 67, 77, and 87 show `core_AllUsers`,
`exe_AllUsers`, and `lib_AllUsers` absent; lines 198-225 show only `_d` and
`_pdb` acquisitions.

RUNTIME_PROOF
No MSI database read, CAB extraction, runtime assembly, process execution,
dependency installation, firmware build, QEMU run, or system mutation was
performed this iteration. The canonical QEMU manifest remains unchanged.

GOOD_VS_BAD
GOOD: signed installer and successful Burn `/layout` boundary remain intact.
BAD: the approved assembly input set is incomplete; using the 3.10 homonyms
would invalidate version/provenance fidelity.

FROZEN_DO_NOT_CHANGE
Production source/QEMU semantics, ABI v5, dispatcher, ProducerLane,
ResponseSlot/C2A, backpressure, watchdog/reset policy, queue depth, canonical
runtime, rollback artifact, PATH/registry/ACLs, and Git history.

CANDIDATE_ACTION
Reviewer should authorize one exact provenance-preserving acquisition method
for the missing 3.8.10 base MSIs, or explicitly close this runtime route.

WHY_REVIEW_IS_REQUIRED
Proceeding requires crossing the reviewer-approved “accepted layout only”
boundary with artifacts that are absent. This is a provenance/process decision,
not a safe routine assembly step.
