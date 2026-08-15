# 39 — Marketplace Release Packaging and CI Matrix

**Status:** NOT STARTED  
**Priority:** Release-critical  
**Depends on:** `35`, `36`  
**Related:** current `scripts/package-release.js`, extension `package.json`

## 1. Goal

Define build/release checks so Marketplace installation reliably includes or provisions every LasecSimul runtime component.

---

## 2. Platform-specific packages

Create CI jobs per supported target.

Initial candidate:

```text
win32-x64
linux-x64
```

Each target must produce a platform-specific VSIX.

Expand only after runtime compatibility exists.

---

## 3. Package contents validation

CI MUST inspect final VSIX and assert presence of:
- extension bundle;
- package manifest;
- Core binary;
- device catalog;
- schemas;
- built-in process SVG assets;
- bootstrap manifest;
- bootstrap implementation;
- Python worker bootstrap code;
- required native libraries.

Avoid previous class of bug where source files existed in repo but disappeared from packaged extension.

---

## 4. Runtime manifest validation

CI:
- schema validates manifest;
- no `latest` unpinned version;
- every URL uses approved HTTPS source;
- every external artifact has SHA-256;
- every target has expected executable;
- every license field exists.

---

## 5. Clean-machine smoke test

For every release target:

```text
1. start clean VS Code test environment
2. install VSIX
3. activate extension
4. execute Setup
5. run Check Installation
6. open basic circuit
7. run circuit
8. run native process demo
9. run Python demo
10. run GHDL demo if supported
```

The release should fail if a required step fails.

---

## 6. Upgrade smoke test

Test:
- install previous Marketplace-compatible version;
- run setup;
- upgrade extension;
- ensure runtime migration/reuse;
- ensure new required component installed;
- old project opens.

---

## 7. Repair test

Intentionally corrupt one managed file.

Expected:
- Check Installation detects failure;
- Repair downloads/replaces component;
- active project remains intact.

---

## 8. Offline test

Install VSIX plus offline runtime bundle with network disabled.

Expected:
- all supported features pass self-test.

---

## 9. Packaging size budget

Track:
- VSIX compressed size;
- first-run download size;
- unpacked runtime size.

A size increase above threshold requires review.

---

## 10. Release metadata

Publish:
- supported platforms;
- included Core version;
- managed Python version;
- managed GHDL version;
- runtime bundle version;
- minimum VS Code version;
- notable compatibility changes.

---

## 11. Acceptance criteria

A release artifact is not publishable unless clean-machine installation and runtime self-tests pass on every claimed platform.
## 12. SharedHost release test

Every release that claims laboratory support SHOULD include:

```text
1. provision one shared runtime
2. create multiple isolated user/session roots
3. launch multiple Core sessions
4. verify all use the same read-only runtime binaries
5. verify unique temp/IPC/GHDL/Python state
6. run simultaneous simulations
7. verify worker/thread budgets
8. verify no cross-session virtual network traffic
```

---

## 13. Deployment-profile compatibility

The same extension build and Core version must execute projects under:

```text
PersonalDesktop
SharedHost
```

No feature may exist only because a second Core binary was built for the laboratory.

---

## 14. Capacity claims

Marketplace/readme must not promise a number of concurrent students without a versioned benchmark report from spec `46`.
