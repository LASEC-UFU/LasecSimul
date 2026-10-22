# ADR-0019 — Bloco Python Programável integrado ao grafo de sinais

## Status

Implementada e validada por build, testes automatizados de integração e medições de desempenho no Windows.

## Contexto

O LasecSimul já possui dois precedentes relevantes, mas com papéis diferentes:

- O bloco PLC é o precedente de produto: configuração por instância, pinos variáveis, ações de edição, ciclo de execução, diagnóstico e integração com a sessão.
- O Signal Engine é o contrato correto para sinais entre blocos. Ele já representa `Real`, `Bool` e `Int64`, resolve portas nomeadas e integra sinais de controle, instrumentos, HMI e registros.
- `PythonRuntime` já mantém um processo worker, compila/retém código por instância e recebe tempo virtual, mas sua API `double` e o acionamento manual por lote ainda não o conectam ao ciclo normal do grafo.

O Wokwi Custom Chips API é uma referência útil para manifestos declarativos, portas nomeadas, estado por instância e ciclo de vida. O seu backend WASM e a sua API de pinos não são adequados para adoção direta: o requisito do LasecSimul é executar com o ambiente Python ativo do workspace VS Code e participar do contrato de sinais já existente.

## Decisão

1. Modelar `Python Programável` como componente de sinal, com `signalPorts()` dinâmico e tipos nativos do Signal Engine. Seus pinos não serão pinos elétricos MNA. Integração com circuitos elétricos ocorrerá pelos sensores/atuadores e pontes já existentes, preservando a fronteira entre solver elétrico e grafo de sinais.
2. Usar o PLC como referência para autoria por instância, configuração de portas, ações e diagnóstico; usar o Signal Engine como autoridade para conexão, tipagem, propagação, observabilidade e resolução temporal.
3. Estender o worker Python persistente existente, sem iniciar processo por bloco ou por ciclo. O worker será inicializado com o executável resolvido pela extensão VS Code; configuração e código são enviados ao preparar/publicar a simulação, e ciclos enviam somente valores e metadados temporais.
4. Executar blocos Python em fronteiras determinísticas de agendamento do tempo simulado, nunca em iterações internas do solver MNA. Definir a causalidade e o período como parte da configuração serializada e do contrato do plano de simulação.
5. Expor entradas como variáveis Python de leitura e saídas por atribuição direta. O estado persistente permanece isolado por instância. Tipos de porta incluem `bool`, `int64` e `real`; identificadores devem ser identificadores Python únicos e não reservados.
6. Salvar código, portas, período e políticas funcionais no projeto. O caminho do interpretador é uma seleção local do workspace e não é serializado como dependência do projeto.
7. Usar a API pública da extensão Python do VS Code quando disponível para obter o ambiente ativo e receber mudanças. O host resolve e valida o executável em caminho direto, sem shell; um fallback explícito deve reportar a origem do ambiente e nunca alterar configuração global.
8. Manter execução fora do processo principal, com timeout, limites de recursos, diagnósticos e falha isolada. Não declarar sandbox de segurança: código Python e bibliotecas do usuário executam com as permissões do processo do interpretador.

## Contrato temporal inicial

O worker recebe `sim.time`, `sim.dt` e `sim.step` no instante do scan. A sessão publica resultados no grafo na fronteira definida pelo scheduler; assim, sinais de saída são estáveis durante a próxima avaliação do grafo e não alteram retroativamente a solução elétrica já calculada. O período usa nanossegundos de tempo virtual e deve ser múltiplo/respeitar a resolução configurada pelo scheduler. Pausa preserva estado; reset reinicializa estado de cada instância; erro suspende o bloco ou a simulação conforme política explícita, mantendo diagnóstico.

## Alternativas consideradas

- **Copiar o runtime WASM do Wokwi:** rejeitado porque não usa o interpretador selecionado pelo VS Code nem se integra ao ciclo e ao modelo de tipos do LasecSimul.
- **Criar um runtime Python paralelo inspirado no PLC:** rejeitado porque duplicaria o worker e o protocolo de processos já existentes.
- **Executar Python dentro do solver elétrico:** rejeitado porque solver pode iterar várias vezes por passo e precisa de componentes determinísticos e de baixo custo; IPC nesse caminho aumentaria latência e poderia invalidar convergência.
- **Representar portas Python como fios MNA:** rejeitado porque `Bool`, `Int64` e `Real` já pertencem ao Signal Engine e não devem ser confundidos com tensão/corrente elétrica.

## Consequências e validação

A integração do componente, contrato tipado, scheduler do Signal Engine, worker persistente, seleção do interpretador e editor nativo do VS Code foi implementada. Os testes do runtime exercitam execução, erro, timeout e restart; os testes do bloco confirmam portas, valores tipados, publicação no grafo, ponte elétrica, binding HMI e persistência dos cinco projetos de demonstração. As medições de latência, CPU e memória para 1/10/100 blocos estão publicadas em `docs/python-programavel/benchmark-windows-2026-10-21.md`; elas registram que a execução é limitada pelo custo síncrono do IPC, principalmente em períodos curtos e muitos blocos.
