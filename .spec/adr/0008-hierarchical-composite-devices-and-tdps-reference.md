---
id: ADR-0008
kind: adr
status: accepted
dependsOn: [ADR-0001, ADR-0002, ADR-0005]
supersedes: []
---

# Processos TDPS-like como subcircuitos nativos do LasecSimul

## Contexto

O repositório atual já possui uma arquitetura madura para subcircuitos reutilizáveis:

- arquivo `.lssubcircuit` schemaVersion 3;
- `components` + `topology` para o circuito interno;
- `interface[]` mapeada para `connectors.tunnel`;
- `symbol` usando o mesmo `PackageDescriptor` do catálogo;
- `exposedComponents[]` para projeção visual de componentes internos;
- `exportedPropertyComponentIds[]` para expor propriedades internas;
- `SubcircuitRegistry` e `SubcircuitDefinition` no Core;
- expansão recursiva na mesma `SimulationSession`, sem `IComponentModel` de subcircuito e sem matriz/solver filho.

A análise do TDPS v7.71 mostra que processos, controladores e estratégias avançadas podem ser representados por blocos conectados. Portanto, criar uma segunda abstração hierárquica (`CompositeDevice`, `CompositeDefinition`, `SubsystemDefinition`) duplicaria capacidades que o projeto já possui e aumentaria acoplamento e custo de manutenção.

## Decisão

1. **Processo TDPS-like é um subcircuito normal.** Não existe tipo estrutural paralelo chamado Composite/Subsystem para esta finalidade.
2. O símbolo externo é `symbol` do `.lssubcircuit`; a implementação interna permanece em `components` + `topology`.
3. A interface externa continua baseada em `interface[]` + `connectors.tunnel`, exatamente como os subcircuitos existentes.
4. O Core continua expandindo o subcircuito dentro da mesma `SimulationSession`; não existe `TDPSEngine`, `ProcessEngine`, solver filho nem `IComponentModel` de subcircuito.
5. Propriedades externas reutilizam `exportedPropertyComponentIds[]` e o mecanismo atual de property schema. Só será criada granularidade adicional por propriedade se um caso real demonstrar que exportar todas as propriedades de um componente é insuficiente.
6. Componentes internos que precisem aparecer no símbolo/placa reutilizam `exposedComponents[]`; exposição visual e exportação de propriedades continuam independentes.
7. Novas primitivas C++/Signal Engine só são criadas quando pelo menos uma destas condições for verdadeira:
   - não é possível reproduzir o comportamento pela composição atual;
   - a composição introduz erro matemático ou semântico relevante;
   - desempenho medido justifica uma primitiva stateful especializada;
   - a primitiva é reutilizável em múltiplos modelos, não apenas em um template TDPS.
8. Estratégias como FOPDT, Smith Predictor, processo com válvula/atuador/dead-time, forno ou caldeira devem ser avaliadas primeiro como `.lssubcircuit` composto por blocos já existentes.
9. Importação `.smp` é um adapter de autoria: converte o modelo legado para `.lsproj`/`.lssubcircuit` normais. O runtime canônico nunca mantém `Mnn`, `Indice lista ...` ou uma tabela global TDPS.
10. A implementação deve seguir SOLID:
    - SRP: subcircuito encapsula hierarquia; primitivas implementam comportamento matemático; importer só converte legado;
    - OCP: novos processos entram como novos documentos/subcircuitos sempre que possível;
    - LSP: um processo reutilizável se comporta como qualquer outro subcircuito nas operações de catálogo, inserção, remoção e nesting;
    - ISP: APIs TDPS-específicas não são adicionadas ao contrato geral do subcircuito sem necessidade comprovada;
    - DIP: importador e biblioteca dependem dos contratos existentes de catálogo/projeto/subcircuito, não de detalhes do TDPS.

## Consequências

- o trabalho TDPS amplia a biblioteca e, no máximo, acrescenta primitivas matemáticas reutilizáveis;
- a infraestrutura de subcircuito permanece a única fronteira hierárquica data-driven;
- `SubcircuitDefinition`, `SubcircuitRegistry`, `SubcircuitDocument`, `Tunnel`, `symbol`, `exposedComponents` e exports existentes são reaproveitados;
- não haverá schema concorrente para processo;
- qualquer extensão no schema v3 deve ser incremental, justificada por caso real e preferencialmente genérica para todos os subcircuitos;
- os testes de processo devem provar equivalência entre o subcircuito e sua expansão manual, além da compatibilidade matemática desejada com fixtures TDPS.

## Rejeitado

- `CompositeDevice`/`CompositeDefinition` paralelo ao subcircuito;
- `CompiledSubsystemTemplate` como requisito antecipado para esta feature;
- `parameterExports[]` paralelo ao mecanismo atual de propriedades exportadas;
- `telemetryExports[]` novo sem antes reutilizar Probe/Scope/componentes expostos/telemetria existentes;
- flattening antecipado na Extension;
- sessão/solver filho por processo;
- bloco monolítico `TDPSProcess` apenas para reproduzir uma combinação que já pode ser montada com primitivas existentes.
