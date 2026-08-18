---
id: ADR-0006
kind: adr
status: superseded
dependsOn: [ADR-0001, ADR-0002]
supersedes: []
---

# IEC 61131-3: POUs cross-language sobre IR e ABI comuns

> **Superseded por [ADR-0007](0007-openplc-v4-incorporation-and-native-plc-pipeline.md).** A decisão de reimplementar as cinco linguagens do zero sobre uma `IecCanonicalIR`/VM de bytecode própria, sem incorporar código do OpenPLC v4, foi revisitada: o LasecSimul agora incorpora diretamente os editores LD/FBD e o pipeline ST -> C++ do OpenPLC v4/STruCpp, relicenciando o produto sob GPL-3.0. O conteúdo abaixo é preservado como registro histórico da decisão original, não como contrato vigente.

## Contexto

O LasecSimul deve editar e simular LD, FBD, ST, SFC e IL, inclusive permitindo que um bloco escrito em uma linguagem seja utilizado por outra. Implementar cinco runtimes isolados tornaria tipos, bibliotecas, debug e semântica de estado divergentes.

O OpenPLC Editor v4 demonstra dois princípios úteis: diferencia POUs textuais e gráficos mantendo os mesmos tipos de POU, e sua geração para compilação resolve blocos definidos pelo usuário a partir da interface do projeto. Esses princípios são adotados como referência, sem exigir incorporação direta do código OpenPLC.

## Decisão

1. As cinco linguagens são front-ends de primeira classe.
2. `PouInterface` é independente de linguagem.
3. Todos os corpos são baixados para uma `IecCanonicalIR` comum.
4. Um único linker IEC resolve tipos, símbolos, FUNCTIONs e FUNCTION_BLOCKs entre linguagens.
5. O backend inicial gera `PlcBytecode` com ABI versionada.
6. O Core contém uma única PLC VM determinística e não um interpretador por linguagem.
7. `FUNCTION_BLOCK` mantém estado por instância; `FUNCTION` não possui memória de instância persistente; `PROGRAM` é raiz ligada a task/resource.
8. A matriz de interoperabilidade 5×5 é gate obrigatório.
9. IL permanece suportada explicitamente para compatibilidade e ensino, embora possa receber marcação de legado na UI.

## Consequências

Positivas:

- um FB ST pode ser arrastado para LD/FBD/SFC e chamado em IL;
- um FB LD/FBD/SFC/IL pode ser chamado em ST;
- tipos, timers, debug, libraries e testes possuem uma semântica única;
- runtime permanece pequeno e determinístico;
- backend nativo futuro pode reutilizar a mesma IR/ABI.

Custos:

- exige front-end/lowering correto para cinco linguagens;
- SFC precisa de lowering explícito de steps/transitions/actions para máquina de estados;
- source maps devem sobreviver ao lowering para debug visual/textual;
- compatibilidade de bibliotecas exige versionamento de tipos e ABI.

## Rejeitado

- cinco interpretadores independentes;
- converter cada par de linguagens diretamente (25 tradutores);
- usar ST textual como API pública entre POUs;
- depender de um OpenPLC Runtime externo durante a simulação;
- remapear I/O por posição após recompilação.
