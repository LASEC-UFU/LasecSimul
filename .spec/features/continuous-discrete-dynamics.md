---
id: FEAT-002
kind: feature
status: planned
dependsOn: [FEAT-001, ARCH-003]
supersedes: []
---

# Dinâmica contínua e discreta

## Escopo inicial

- integrador, derivada filtrada, atraso discreto, FirstOrder, FOPDT, tanque e válvula;
- estado contínuo separado de slots de sinal;
- métodos explícitos com tolerância e passo adaptativo documentados;
- rollback local antes de publicar um tempo aceito;
- descontinuidades agendam fronteiras explícitas no Scheduler.

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
- erro/timestep e passos rejeitados são observáveis.
