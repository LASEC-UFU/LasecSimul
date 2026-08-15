# Installing this `.spec` Package

Extract the ZIP at the **root of the LasecSimul repository**.

Expected result:

```text
LasecSimul/
├── .spec/
│   ├── README.md
│   ├── STATUS.md
│   ├── DECISIONS.md
│   ├── 00-vision-and-architecture.md
│   ├── ...
│   ├── 48-simulation-backend-local-remote-abstraction.md
│   └── 99-spec-template.md
├── core/
├── extension/
└── ...
```

Recommended Windows repository example:

```text
C:\SourceCode\LasecSimul\.spec\
```

## Using with a coding agent

Do not send all specs blindly.

For each task include:
- `.spec/README.md`
- `.spec/22-agent-implementation-rules.md`
- `.spec/DECISIONS.md`
- `.spec/STATUS.md`
- only the relevant feature specs.

Example: SharedHost architecture work:

```text
00-vision-and-architecture.md
43-performance-concurrency-threading.md
44-thin-client-multiuser-resource-governor.md
45-shared-runtime-laboratory-deployment.md
46-performance-benchmark-capacity-planning.md
47-virtual-network-multiuser-isolation.md
48-simulation-backend-local-remote-abstraction.md
35-marketplace-one-click-installation.md
36-managed-toolchain-bootstrap.md
37-first-run-onboarding-and-setup-prompt.md
39-marketplace-release-packaging-and-ci.md
```

The agent must inspect current code before proposing exact class/file changes.
