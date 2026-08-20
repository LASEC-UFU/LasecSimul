---
id: FEAT-002
kind: feature
status: active
dependsOn: [FEAT-001, ARCH-003]
supersedes: []
---

# Dinâmica contínua e discreta

## Escopo inicial

- integrador, derivada filtrada, atraso discreto/DeadTime, Gain, FirstOrder, SecondOrder, LeadLag, FOPDT, tanque e válvula;
- não linearidades de processo reutilizáveis: Saturation, Hysteresis/Deadband, Stiction e RateLimiter;
- dinâmica opcional de atuador por FirstOrder;
- estado contínuo separado de slots de sinal;
- métodos explícitos com tolerância e passo adaptativo documentados;
- rollback local antes de publicar um tempo aceito;
- descontinuidades agendam fronteiras explícitas no Scheduler.



## Blocos de processo compostos

Parâmetros agrupados de equipamentos não exigem uma classe monolítica. `FEAT-004` permite publicar uma cadeia de primitivas como um único símbolo externo.

O perfil inicial inspirado no `PROCESSO` do TDPS pode compor, quando habilitados:

```text
input -> ValveCharacteristic -> Hysteresis/Stiction -> RateLimiter
      -> ActuatorFirstOrder -> LeadLag/FirstOrder/SecondOrder
      -> DeadTime -> Saturation -> output
```

A equivalência deve ser definida por equações e goldens. Campos legados cujo significado exato não esteja comprovado permanecem explicitamente não suportados até haver evidência.

## Implementação inicial da F6

- o `SignalRuntime` mantém estado dinâmico denso separado dos slots publicados;
- passos contínuos usam RK4, com estimativa de erro por um passo completo contra dois meios passos e tolerâncias absoluta/relativa do `Scheduler`;
- o protocolo `beginContinuousStep`/`commitContinuousStep`/`rollbackContinuousStep` garante que tentativas rejeitadas não sejam observáveis externamente;
- `DeadTime` e FOPDT usam histórico circular pré-alocado e publicam a próxima descontinuidade como fronteira explícita do `Scheduler`;
- métricas expõem passos aceitos/rejeitados, último passo, último erro normalizado, eventos de descontinuidade e descarte por capacidade de histórico;
- os blocos cobertos são Integrator, FilteredDerivative, UnitDelay, DeadTime, Gain, FirstOrder, SecondOrder, LeadLag, FOPDT, Tank, ValveCharacteristic, Saturation, Deadband, Hysteresis, Stiction e RateLimiter;
- a dinâmica opcional de atuador é representada pela composição com `FirstOrder`, sem criar um solver paralelo.

Os testes automatizados incluem goldens de primeira ordem e FOPDT, convergência com redução de passo, rollback, pausa/resume independente de wall clock, fronteira de atraso, estado isolado, armazenamento estável, validação de parâmetros, primitivas isoladas e cadeia composta.

## Regras

- parâmetros usam unidades coerentes;
- estados não são persistidos no projeto salvo;
- runtime externo não observa tentativa de passo rejeitada;
- bloco discreto não é automaticamente bloco IEC/PLC;
- solver universal entre MNA e processo está fora do escopo.

## Aceitação

- golden de primeira ordem e FOPDT;
- convergência ao reduzir passo;
- pausa/resume sem salto de wall clock;
- evento em descontinuidade não é perdido;
- erro/timestep e passos rejeitados são observáveis;
- cada primitiva usada pelo composite TDPS-like possui teste isolado e teste da cadeia completa.
