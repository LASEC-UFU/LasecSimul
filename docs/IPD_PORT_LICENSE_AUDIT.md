# IPD port/license audit

The authoritative provenance and per-subsystem reuse matrix is
[`third-party/IPD_STUDIO_PROVENANCE.md`](third-party/IPD_STUDIO_PROVENANCE.md).

Decision for the first production migration:

- use the current IPD Studio implementation as the architecture/behavior reference;
- retain the obstacle-aware router port from the AGPL-3.0-only `0.12.1` revision, avoiding a
  PolyForm/GPL distribution conflict for this subsystem; current `routePipes.ts` has since evolved
  and is not claimed byte-equivalent;
- reimplement magnetic docking against LasecSimul's existing model (`CONCEPT_ONLY`);
- preserve LasecSimul's canonical topology, Core authority and project format;
- do not embed or ship IPD Studio as a second application.

Decision for the noncommercial graphical-library migration:

- direct copies/adaptations are permitted only for this noncommercial use and are explicitly marked
  `DIRECT_PORT` or `ADAPTED_PORT` in the provenance register;
- preserve PolyForm Noncommercial 1.0.0, the upstream URL, copyright notice, source files and exact
  commit in generated catalog records and licensed SVG metadata;
- do not replace the license of copied portions with the LasecSimul license and do not remove upstream
  authorship;
- keep independent high-detail supervisory drawings separately classified as `CONCEPT_ONLY`.

Any future current-IPD direct port must add a row to the provenance register before merging and must
retain PolyForm Noncommercial notices in every affected source/asset. This is an engineering audit,
not legal advice.
