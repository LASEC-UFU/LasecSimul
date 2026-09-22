# Third-party licenses

This file is the distribution index. Exact texts and notices are preserved rather than paraphrased
where an upstream copy is available.

| Component | Version/revision | Use in LasecSimul | License | Exact material |
|---|---|---|---|---|
| IPD Studio current | `4b84fb8694bc89985872690366e8be2e32a8db2b` (`v0.22.0-26-g4b84fb8`) | 193 P&ID symbols, identified HMI/device ports, alignment/distribution, keyboard-canvas navigation, vertex cleanup and line styles/ISA glyphs | PolyForm Noncommercial 1.0.0 | `licenses/ipd-studio/LICENSE`, `NOTICE`, `THIRD-PARTY-LICENSES.md`, `COMMERCIAL-LICENSE.md`, `TRADEMARKS.md` |
| IPD Studio historical router | `8d8157e435d6cfffc5a4218fa45f0c4f186c4a35` | adapted orthogonal router | AGPL-3.0-only | source header and `external-research/ipd-studio-agpl/LICENSE` |
| OpenPLC Editor / STruCpp | identified in source headers and `.spec/adr/0007-*` | PLC editor/toolchain/runtime portions | GPL-3.0; runtime headers carry the STruCpp runtime exception | source headers, root `LICENSE`, `LICENSE-RUNTIME-EXCEPTION.txt` |

Required Notice: Copyright © 2026 Praharsh Nagpure (https://github.com/Coldbari/IPD-Studio)

The current IPD dependency inventory reports 577 packages: 106 runtime and 471 development. It is
copied byte-for-byte to `licenses/ipd-studio/THIRD-PARTY-LICENSES.md`. LasecSimul does not currently
ship the IPD React/JointJS/Firebase application or those 577 packages as runtime dependencies; the
copy is retained for provenance and for any future direct module port.

LasecSimul's own npm dependencies retain the licenses distributed in their package directories and
lockfiles. A release process must include the applicable dependency notices for the actual packaged
artifact.
