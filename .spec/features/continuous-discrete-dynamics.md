---
id: FEAT-002
kind: feature
status: planned
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
