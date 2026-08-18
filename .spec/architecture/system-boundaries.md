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
      |                                  |
      +-> IEC Compiler -> PLC artifact --+-> PLC VM interna
```

- A Extension é dona de autoria, UX, catálogo visual, editores IEC, persistência do projeto e política de renderização.
- O toolchain IEC do LasecSimul transforma LD/FBD/ST/SFC/IL em `PlcCompiledArtifact`; compilação não é simulação.
- O Core é dono de tempo virtual, topologia executável, estado de simulação, solver, Scheduler e PLC VM.
- QEMU, GHDL e Python são runtimes subordinados ao Core e nunca autoridades independentes do tempo.
- O PLC IEC **não** depende de processo OpenPLC Runtime externo durante a simulação; o Core executa a ABI/bytecode PLC definida pelo LasecSimul.
- Cada sessão/usuário recebe um processo Core. Não se coloca estado mutável de múltiplos usuários no mesmo Core.
- Desktop e SharedHost usam o mesmo binário e contratos. Mudam apenas perfil, orçamento e deployment.
- Um backend remoto futuro troca transporte e provisionamento, não o motor de física ou a semântica PLC.

## Proibições

- lógica de simulação na Webview/Extension;
- parser/compilador IEC executando a cada scan;
- cinco runtimes PLC separados por linguagem;
- wall clock como relógio funcional de blocos, PLCs ou protocolos simulados;
- porta TCP do host criada implicitamente para endpoint virtual;
- cache global com estado mutável de sessão;
- thread ou processo por bloco/PLC por padrão;
- segunda implementação de Scheduler/solver/PLC VM para SharedHost.

## Ownership

| Recurso | Dono | Compartilhável |
|---|---|---|
| documento de autoria | Extension | snapshot imutável |
| autoria IEC/POUs | Extension | snapshot imutável |
| `PlcCompiledArtifact` | cache de build/Core | sim, imutável/refcount |
| memória de instância PLC | sessão Core | não |
| `SimulationPlan` | sessão Core | somente leitura |
| `RuntimeState` | coordenador da sessão | não |
| módulo de plugin carregado | cache de processo | sim, imutável/refcount |
| instância de plugin | sessão | não |
| cache de compilação | host/projeto | artefatos publicados read-only |
| FPS/render state | Extension | não aplicável ao Core |

## Referência OpenPLC e licença

OpenPLC é referência técnica para organização de POUs, editores e pipeline PLC. A especificação não pressupõe copiar arquivos do projeto. Se código GPL-3.0 for incorporado diretamente ou formar obra derivada, o impacto de licença deve ser decidido antes da integração e documentado em ADR próprio.

## Aceitação

- duas sessões não compartilham estado mutável nem memória PLC;
- crash de uma sessão não encerra outra;
- testes headless não dependem da Extension;
- compilação IEC produz o mesmo formato de artefato para Desktop/SharedHost;
- backend local e remoto expõem o mesmo contrato sem duplicar semântica;
- simular PLC não requer iniciar OpenPLC Editor ou OpenPLC Runtime.
