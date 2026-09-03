# QEMU build and runtime provenance

Consolidated 2026-09-03. This file used to be a third iteration diary that
duplicated `STATUS.md`; that history now lives only in `STATUS.md`, and only
the build/runtime provenance is kept here because rebuilding QEMU is currently
the project's single blocker.

`QEMU_RUNTIME.json` is authoritative for the current canonical hash. The SHA
recorded in the old version of this file
(`58ED43B801E75D87C0B92EEE1ED4AE3A3C6D1C2178D5D893A40EAE0609F459D4`) was
superseded at iteration 54 and is historical only.

## Source repository

- Path: `C:\SourceCode\qemu_lasecSimul`
- Remote: `https://github.com/josuemoraisgh/qemu_lasecSimul.git`
- Branch: `main`, upstream `origin/main`, ahead/behind `0 0`, not detached
- HEAD: `9dc30419a5372756b555ad7926563dcda2215c79` (2026-08-28T19:59:31-03:00)
- Submodules: none
- Worktree: **dirty**

The dirty worktree carries pre-existing tracked edits in the QEMU transport,
ESP32 peripheral, reset/timing and build-registration files, and the untracked
`softmmu/vnext_b.c` / `softmmu/vnext_b.h`. Files under `build-ucrt64` are also
dirty or untracked. None of that was reverted.

Changes made on 2026-09-03 (guard-only diagnostic fixes, see E102/E103):

| File | Tracked? | Revert |
|---|---|---|
| `softmmu/vnext_b.c` | no | `softmmu/vnext_b.c.orig-before-e102`, plus `vnext_b_backpressure_diagnostic.patch` |
| `hw/i2c/esp32_i2c.c` | yes | `git checkout`, plus `esp32_i2c_hotpath_diagnostic.patch` |

## How the canonical runtime is built

The MSYS2 UCRT64 environment described below **is installed on this host** at
`C:\SourceCode\tools\msys64` (installed 2026-09-03 from the official
`msys2-base-x86_64` archive). The path matters: `build-ucrt64/build.ninja`
hardcodes it, so installing elsewhere would require reconfiguring meson.

- Build directory: `C:\SourceCode\qemu_lasecSimul\build-ucrt64`
- Target: `qemu-system-xtensa.exe`
- Build system: Meson + Ninja
- Host config: Windows UCRT64, `CONFIG_WIN32=y`, `CONFIG_TCG=1`,
  `TARGET_DIRS=xtensa-softmmu`
- Compiler: GCC 16.2.0 (MSYS2); Binutils 2.47
- Cap parallelism: `nice -n 19 ninja -j 8 ...` (DECISION-010)
- Configure options already applied in `build-ucrt64`:
  `-Dgtk=disabled -Dsdl=disabled -Dvnc=disabled -Dcurses=disabled
  -Dgcrypt=enabled -Dslirp=enabled -Db_pie=false -Ddocs=disabled`
- Build command (from an MSYS2 UCRT64 shell, in the build dir):
  `nice -n 19 ninja -j 8 qemu-system-xtensa.exe`

If a build is interrupted (power loss, kill) it can leave zero-byte objects and
NUL-filled generated headers that then fail to link with thousands of
`undefined reference to visit_type_*`. Recovery is `ninja -t clean` followed by a
full rebuild. See DECISION-010.

Because the build includes the untracked VNEXT source and the modified tracked
files, any resulting hash is attributable to the current dirty worktree. Exact
historical binary provenance is not claimed beyond build/runtime hash equality.

## Staging the runtime (DECISION-001)

The raw `build-ucrt64` executable is **not** a standalone runtime: launched
without its adjacent DLLs it returns `0xC0000135`. The canonical test runtime is
the staged copy at

```text
C:\SourceCode\LasecSimul\vnext_prototype\dev_qemu_runtime\qemu-system-xtensa.exe
```

which carries the same SHA-256 as the build executable plus the MSYS2 UCRT64 DLL
set beside it. After any rebuild, restage **with** those DLLs and update
`canonical_executable_sha256` in `QEMU_RUNTIME.json`.

## Rollback artifact (DECISION-002)

`C:\SourceCode\LasecSimul\devices\qemu-esp32\bin\qemu-system-xtensa.exe` remains
unchanged at SHA-256
`471AE54193CC7A86F6A448D53BC1E810F5B50D6EBAD1FE48FC34AA04F56F74CE`. It is never
substituted for the canonical runtime.

## Launch shape

Production launch is `-M esp32-simul`, MTTCG (`-accel tcg,thread=multi`), with
Core injecting numeric `tb-size=64`, and the shared-memory arena key passed as
`argv[1]` (`softmmu/main.c`, `simuliface.c::simuMain`).

For standalone device-level work, `-M esp32-simul ... -kernel <file.elf>` boots a
bare-metal image with no Core and no arena — see `QEMU_HANDOFF.md` section 4 and
`vnext_prototype/guest_mwdt_baremetal/README.md`.
