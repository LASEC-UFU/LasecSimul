# `.spec` Consolidation Change Log — 2026-08-15 v2

This edition consolidates specs `00–48`.

Major additions:

- `43` Performance/concurrency/threading model.
- `44` Thin-client/shared-host ResourceGovernor.
- `45` Shared read-only laboratory runtime.
- `46` Benchmark/capacity planning.
- `47` Session-isolated virtual networks.
- `48` Local/remote SimulationBackend seam.

Major revised decisions:

1. Desktop and SharedHost use one Core architecture.
2. Installation selects deployment/resource policy, not a different simulator.
3. `Automatic` is the recommended setup profile.
4. SharedHost is not mislabeled as true client/server.
5. Future remote server is deferred behind a backend abstraction.
6. Per-session bounded workers replace aggressive hardware-wide thread creation.
7. One Python worker per session by default.
8. External runtimes start lazily.
9. Python/GHDL may be shared read-only in labs.
10. Scope/history/animations are resource governed and bounded.
11. Modbus TCP uses a virtual session network by default.
12. Multi-session performance must be benchmarked before capacity claims.

Affected existing specs:
- `00`
- `10`
- `11`
- `14`
- `20`
- `25`
- `28`
- `30`
- `34`
- `35`
- `36`
- `37`
- `39`
- `42`
- `README.md`
- `STATUS.md`
- `DECISIONS.md`
