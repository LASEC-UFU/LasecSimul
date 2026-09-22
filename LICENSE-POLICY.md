# LasecSimul license policy

Audit date: 2026-09-21.

## Current result

LasecSimul's intended use is educational, scientific, personal and otherwise noncommercial.
However, the repository cannot truthfully be changed to a single PolyForm Noncommercial license by
replacing the root `LICENSE` file.

The combined application already incorporates GPL-3.0-or-later code, including direct OpenPLC and
STruCpp ports. The repository also contains an AGPL-3.0-only adapted router. GPL-covered recipients
cannot be denied commercial use by adding a noncommercial restriction. Current IPD Studio code, in
turn, is available under PolyForm Noncommercial 1.0.0 and cannot be unilaterally relicensed as GPL.

Therefore:

- the root `LICENSE` and package metadata remain GPL-3.0-or-later for the existing GPL-covered
  LasecSimul combined work;
- current-IPD direct/adapted portions remain separately identified under PolyForm Noncommercial
  1.0.0, with source, commit and required notice attached;
- the historical router port remains AGPL-3.0-only;
- third-party code keeps its own license and copyright;
- no file is claimed as relicensed unless all necessary copyright holders have authorized that
  change.

The exact current-IPD legal files are preserved byte-for-byte under `licenses/ipd-studio/`. The
historical GPL root license is also mirrored byte-for-byte at
`licenses/lasecsimul/GPL-3.0-or-later.txt`.

## Distribution boundary

Private development and testing can contain components under otherwise incompatible licenses. A
public binary/source distribution that combines GPL-covered and PolyForm-only code into one work
requires a reviewed legal/technical boundary or additional permission from the relevant copyright
holders. Until that is resolved, this repository must not be advertised as a single
PolyForm-licensed work.

Possible compliant directions are: obtain explicit compatible licensing permission; remove or
replace the third-party GPL portions; or package genuinely separate programs/assets as an aggregate
with each license applied only to its own work. This document records the engineering finding and is
not legal advice.
