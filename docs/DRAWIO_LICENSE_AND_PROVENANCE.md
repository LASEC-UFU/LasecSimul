# Draw.io license and provenance

## Audited upstream

- Repository: <https://github.com/jgraph/drawio>
- Local reference checkout: `C:\SourceCode\external-research\drawio`
- Branch: `dev`
- Commit audited: `744cb5420fdf126efd7a09b1d7082ca3e12c0841`
- Audit date: 2026-09-21

The repository-level `LICENSE` is Apache License 2.0. The P&ID stencil directory also contains
`src/main/webapp/stencils/LICENSE`, which carries an additional Atlassian-product/marketplace
restriction for the included icon sets and stencil libraries and derivatives. That notice was
treated as applicable to the stencil source and its derived geometry.

## Reuse decision

LasecSimul uses draw.io as a functional and visual reference only. No draw.io editor, iframe,
runtime parser, XML stencil, copied path, or converted draw.io asset is shipped in the production
tree. The native symbols under `graphics.*` are independently authored declarative
LasecSimul/SimulIDE-style packages and use the existing renderer, palette, Inspector, persistence,
and runtime binding paths.

This avoids treating the stencil notice as permission to redistribute derived industrial artwork.
The audit inventory records source names and primitive/connection metadata for traceability, while
the implementation keeps provenance at the architectural/reference level rather than claiming that
the native symbols are copied draw.io assets.

## License handling requirements

If a future change proposes copying or adapting a particular stencil, it must first:

1. identify the exact source file and commit;
2. preserve the applicable Apache-2.0 notice and stencil-directory notice;
3. verify compatibility with the LasecSimul distribution license;
4. record the adaptation in this document and in the symbol metadata; and
5. obtain additional permission if the stencil-directory restriction applies.
