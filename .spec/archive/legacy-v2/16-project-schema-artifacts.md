# 16 — Project Schema and Artifact Formats

**Status:** PLANNED  
**Priority:** Cross-cutting  
**Depends on:** current schema inspection

## 1. Goal

Add signal graphs, smart instruments, protocol maps, PLC programs and FPGA metadata without breaking existing `.lsproj`, `.lsdevice` and `.lssubcircuit` projects or violating the project's single-file packaging principles.

## 2. First rule: inspect real schema types

Before adding fields, verify:

- current schema version;
- allowed `properties` value types;
- loader strictness;
- unknown-field policy;
- relative-path behavior;
- component topology representation;
- subcircuit interface format;
- extension/Core mirrored DTOs.

Do not serialize structured arrays/maps as JSON strings just to fit a scalar property API.

## 3. `.lsproj`

Future project needs may include:

- electrical topology;
- signal topology;
- component/block instances;
- cross-domain adapters;
- subsystem references;
- PLC artifact references;
- FPGA source references;
- simulation settings;
- protocol endpoints;
- UI layout.

Prefer additive versioned sections.

Candidate conceptual structure:

```json
{
  "schemaVersion": 3,
  "components": [],
  "electricalTopology": {},
  "signalTopology": {},
  "simulationSettings": {},
  "artifacts": {}
}
```

This is illustrative, not a mandated schema.

## 4. Stable IDs

Persist stable IDs for:

- component;
- electrical pin;
- signal port;
- subsystem interface;
- PLC variable/channel;
- protocol endpoint;
- binding target.

Display names are never IDs.

## 5. Relative paths

Project-relative when possible:

- FPGA VHDL sources;
- PLC program artifact;
- imported tables/profiles;
- subsystem files.

On move/copy, the project should remain self-contained where assets are inside project tree.

## 6. `.lsdevice`

Continue using it as canonical packaged device definition where appropriate.

Do not duplicate:

```text
catalog entry
+
separate config file
+
different runtime manifest
```

unless architecture truly requires it.

Palette visibility and Core implementation availability are separate and both must be validated.

## 7. `.lssubcircuit`

Preserve compatibility.

Potential schema evolution:

- typed interface ports;
- mixed-domain internal topology;
- exported runtime parameters;
- smart-device metadata.

Old subcircuits must load unchanged.

## 8. `.lsplc`

Potential dedicated artifact justified because PLC project contains source programs/POUs/tasks beyond normal component properties.

Before adopting:
- compare with embedding in `.lsproj`;
- consider project portability;
- consider future PLCopen import/export.

## 9. `.lshart` / smart-instrument profile

Do not add by default.

A HART device profile could be:

- data in smart subsystem;
- packaged `.lsdevice`;
- profile JSON inside device package.

Introduce new extension only if it has independent user workflow and stable identity.

## 10. Migration

Each version bump must have:

- schema validation;
- migration function/test;
- golden old-project fixtures;
- forward-unknown policy documented.

Never silently discard unsupported fields during save.

## 11. Autosave/dirty behavior

Editing:

- signal line;
- register map;
- PLC program;
- HART config;
- FPGA sources/top;
- subsystem interface

must mark the correct artifact/project dirty.

## 12. Tests

Golden fixtures:

- old electrical project;
- old subcircuit;
- project with signal graph;
- hybrid subsystem;
- HART instrument;
- Modbus register map;
- PLC reference;
- FPGA source list.

Test:
- load;
- save;
- reload;
- semantic equality;
- no unrequested field loss.

## 13. Acceptance criteria

New domains can persist without abusing scalar properties, and current production project files remain loadable.
