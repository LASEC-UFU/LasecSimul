# OpenPLC Editor v4 provenance

The IEC authoring adapter tracks `Autonomy-Logic/openplc-editor` tag `v4.2.10`, commit
`0cf29e23a5158efa84d64201a3665339dd448ffd`, under GPL-3.0-only. The immutable source paths and
SHA-256 values used by the adapter are recorded in `scripts/openplc-editor-pin.json`.

`openPlcLibraryTypes.ts` preserves the upstream library-port shapes used by the common block
browser. `lowering.ts` is the LasecSimul host adapter for the pinned LD/FBD-to-ST contract; SFC is
LasecSimul-owned, as upstream does not provide the required production SFC lowering contract.

Do not update the adapter from an unpinned branch. Review the upstream GPL license, update the tag,
commit and all hashes together, then rerun the 5×5 interoperability suite.
