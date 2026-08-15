---
id: ARCH-003
kind: architecture
status: active
dependsOn: [ARCH-002]
supersedes: []
---

# Scheduler e tempo virtual

## Autoridade

O Scheduler/coordenador é a única autoridade do tempo virtual e da ordem observável. Runtimes externos avançam somente por comando do Core.

## Chave de evento

```cpp
EventKey { timestampNs, microstep, phase, sequence }
```

Ordem lexicográfica fixa. `sequence` preserva desempate determinístico.

Fases mínimas:

1. `ExternalInput`;
2. `DiscreteEvaluate`;
3. `ElectricalSettle`;
4. `Commit`;
5. `Observe`.

Propagação zero-delay agenda `microstep + 1`. Um limite configurável detecta loop algébrico/oscilações e gera diagnóstico, nunca loop infinito.

## RateGroups

Blocos com o mesmo `(periodNs, offsetNs, phase)` compartilham um evento periódico e são avaliados em ordem de índice do plano. O grupo agenda uma única próxima ativação.

Períodos inteiros em nanossegundos são o contrato inicial. Representação racional, timing wheel e calendar queue ficam adiados até benchmark/caso de uso concreto.

## Passos contínuos

O integrador pode escolher passos menores que o próximo evento, respeitando limites e rollback. Eventos externos e GHDL só observam tempos aceitos; tempo nunca retrocede para um runtime que não suporte rollback.

## Alocação

- reutilizar buffers de lotes e scratch;
- reduzir eventos primeiro com RateGroups;
- manter a `priority_queue` até profiler provar gargalo;
- evitar `future`/promise por evento.

## Aceitação

- ordem reproduzível em eventos de mesmo instante;
- pausa/stop responsivos inclusive em não convergência;
- loop de microsteps limitado e diagnosticado;
- RateGroup gera um evento por período, não por bloco;
- nenhum uso funcional de wall clock.
