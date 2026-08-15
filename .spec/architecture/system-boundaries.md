---
id: ARCH-001
kind: architecture
status: active
dependsOn: []
supersedes: []
---

# Fronteiras do sistema

## Contrato

O LasecSimul possui uma única arquitetura de simulação:

```text
Authoring/UI -> Backend contract -> Core por sessão -> runtimes externos opcionais
```

- A Extension é dona de autoria, UX, catálogo visual, persistência do projeto e política de renderização.
- O Core é dono de tempo virtual, topologia executável, estado de simulação, solver, Scheduler e coordenação de processos externos.
- QEMU, GHDL e Python são runtimes subordinados ao Core e nunca autoridades independentes do tempo.
- Cada sessão/usuário recebe um processo Core. Não se coloca estado mutável de múltiplos usuários no mesmo Core.
- Desktop e SharedHost usam o mesmo binário e contratos. Mudam apenas perfil, orçamento e deployment.
- Um backend remoto futuro troca transporte e provisionamento, não o motor de física.

## Proibições

- lógica de simulação na Webview/Extension;
- wall clock como relógio funcional de blocos, PLCs ou protocolos simulados;
- porta TCP do host criada implicitamente para endpoint virtual;
- cache global com estado mutável de sessão;
- thread ou processo por bloco por padrão;
- segunda implementação de Scheduler/solver para SharedHost.

## Ownership

| Recurso | Dono | Compartilhável |
|---|---|---|
| documento de autoria | Extension | snapshot imutável |
| `SimulationPlan` | sessão Core | somente leitura |
| `RuntimeState` | coordenador da sessão | não |
| módulo de plugin carregado | cache de processo | sim, imutável/refcount |
| instância de plugin | sessão | não |
| cache de compilação | host/projeto | artefatos publicados read-only |
| FPS/render state | Extension | não aplicável ao Core |

## Aceitação

- duas sessões não compartilham estado mutável nem nomes de arena;
- crash de uma sessão não encerra outra;
- testes headless não dependem da Extension;
- backend local e remoto expõem o mesmo contrato sem duplicar semântica.
