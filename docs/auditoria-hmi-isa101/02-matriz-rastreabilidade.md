# Matriz de rastreabilidade e gaps

Esta matriz separa **estado observado no produto** de **classificação normativa**. Não houve comparação com texto integral autorizado da ANSI/ISA-101. Assim, em todas as linhas, “classificação normativa pendente” significa que não se afirma obrigação, recomendação ou atendimento daquela norma. “Boa prática” abaixo significa proposta de engenharia da equipe, não citação normativa. A matriz deve ganhar IDs/cláusulas só após revisão autorizada.

| Domínio | Estado do produto observado | Situação de produto | Classificação normativa | Evidência / gap e próximo passo |
|---|---|---|---|---|
| Modelo de aplicação e telas | `HmiApplication` opcional persistido com páginas; modo de autoria e cena HMI no canvas; elementos locais referenciam componentes ou gráficos independentes | Parcial | Pendente de texto autorizado | `ProjectTypes.ts`, `ProjectSerializer.ts`, `main.ts`; falta evoluir modelo/bindings conforme tarefas reais |
| Hierarquia de telas e navegação | Páginas nomeadas, página inicial, atalhos posicionáveis e modo Operar; não há hierarquia overview/detail guiada por tarefas | Parcial | Pendente | Fazer workshop de tarefas e validar navegação com operadores |
| Layout responsivo e viewport | Dimensões por página configuráveis e canvas com zoom/pan; não há perfil operacional de resolução/distância | Parcial | Pendente | Definir displays/postos reais; validar em viewport representativo |
| Símbolos de processo | 193 formas P&ID estáticas; 5 primitivos e outros vetores | Parcial | Pendente | Reusar geometria atual; mapear aos modelos Core e complementar estados/bindings onde faltarem; comparar semântica contra referência licenciada |
| Cobertura de equipamento dinâmico | Dez widgets HMI, alguns equipamentos com animação/valor | Parcial | Pendente | Mapear widget existente por família; complementar estados no Core e widget só se houver lacuna de tarefa |
| Semântica visual e tokens | Propriedades visuais por instância; sem tema/tokens semânticos do projeto | Parcial | Pendente | Tokens centralizados, estados redundantes a cor e lint |
| Binding e unidades | Metadados de fonte, escala, offset, faixa/unidade/formatação; 30 entradas com bindSource | Parcial | Pendente | Resolver tags declarativas, unidades tipadas, validação ao compilar |
| Qualidade e idade do dado | Binding gráfico diferencia fonte ausente (`bad/missing`), transporte indisponível (`disconnected`) e inatividade de frames (`stale`); timeout HMI opcional por projeto, desativado por padrão. O frame coerente fornece timestamp simulado compartilhado, não timestamp individual por fonte | Parcial | Pendente | Formalizar amostra tipada com quality e proveniência por fonte; validar timeout com processo/runtime |
| Falha de comunicação | Falha IPC de frame limpa leituras, estados, overlays e tensões; bindings gráficos mostram `OFFLINE`, distinto de `missing` e `stale` | Parcial | Pendente | Acrescentar diagnóstico detalhado e validar timeout por processo sem reter valor congelado como atual |
| Alarmes | Comparação visual de limites/indicador/banner; sem ciclo/ack/event journal | Não atendido como serviço de alarmes | Pendente | Serviço de alarmes, estados e eventos aprovados pelo domínio |
| Priorização e resposta a alarmes | Sem catálogo de prioridades e fluxo operacional completo | Não atendido | Pendente | Definir com processo e operadores; cenários e evidências |
| Tendências de variáveis de processo | Histórico de osciloscópio/analisador lógico; sem historian de tags HMI | Não atendido como trend de processo | Pendente | Serviço de amostragem/retensão e visualização navegável |
| Comandos de operador | Ações genéricas escrevem propriedade local de alvo; prompt numérico | Parcial | Pendente | Gateway único, validação, estados e resposta correlacionada |
| Autorização e papéis | Não identificado controle por usuário/role | Não atendido | Pendente | Modelo de identidade/permissão e testes negativos |
| Intertravamentos e permissivos | Não há serviço comum de permissivos/ack; caminho overlay envia atualização direta | Não atendido | Pendente | Aplicar permissivos no Core/command service, nunca só no widget |
| Estado do sistema/modo | Canvas possui contexto de edição/simulação; proteção inconsistente a validar entre superfícies | Parcial | Pendente | Especificar edit/run; cobrir canvas e subcircuito por E2E |
| Consistência de estados e feedback | Binding projeta valor/estado; comando não tem confirmação industrial comum | Parcial | Pendente | Estados pending/accepted/rejected/timeout e readback |
| Persistência e versionamento | `HmiApplication` opcional serializado no `.lsproj` e `.lssubcircuit`; geometria HMI é local e não reorganiza o esquemático | Parcial | Pendente | Executar round-trip cobrindo IDs, posições, dimensões, escala, rotação, ordem e navegação; confirmar projetos legados sem HMI |
| Usabilidade, legibilidade e acessibilidade | Folha visual de widgets; sem avaliação com operador/condição real | Não verificado | Pendente | Testes de tarefa com participantes e hardware de destino |
| Desempenho e escalabilidade | Poll de 300 ms e atualizações visuais; sem benchmark de carga/end-to-end | Não verificado | Pendente | Perfil de cargas medido; limites escolhidos pelo projeto |
| Resiliência e recuperação | Erros por tick são ignorados; sem plano end-to-end de reconexão operacional | Parcial | Pendente | Testar falha, reconexão, valor retido e estado degradado |
| Auditoria e trilha operacional | Sem trilha comum de comandos/alarmes identificada | Não atendido | Pendente | Eventos com ator, origem, resultado e relógio confiável |
| Testabilidade e evidências | Unit, round-trip, visual render e Core real; sem E2E de operação completa | Parcial | Pendente | Expandir matriz com requisito autorizado e evidência reproduzível |
| Segurança da distribuição de ativos | Proveniência registra PolyForm Noncommercial 1.0.0 em ativos derivados | Não verificado juridicamente | Fora da classificação técnica; revisão legal | Resolver direitos/licenciamento antes do uso comercial |

## Campos para a revisão normativa licenciada

Para cada requisito aplicável, adicionar: identificador/edição/cláusula copiado por revisor autorizado; texto sob controle de acesso apropriado; interpretação e aplicabilidade; dono; decisão de design; referência a código/configuração; teste e resultado; captura/registro de evidência; exceção aprovada; assinatura e versão avaliada. Não preencher esses campos por inferência de títulos, resumos públicos ou aparência do produto.
