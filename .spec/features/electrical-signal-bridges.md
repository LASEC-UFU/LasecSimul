---
id: FEAT-003
kind: feature
status: active
dependsOn: [FEAT-001, FEAT-002, ARCH-006]
supersedes: []
---

# Bridges elétrico ↔ sinal

Bridges são componentes explícitos e pertencem aos dois planos apenas por handles compilados.

## MVP

- VoltageSensor e CurrentSensor;
- DigitalInput com limiares/histerese;
- ControlledVoltageSource e ControlledCurrentSource;
- DigitalOutput com nível elétrico explícito;
- Sample/Hold quando domínios usam taxas diferentes.

Sensores leem resultado aceito do domínio elétrico. Atuadores escrevem contribuição para a próxima fase elétrica definida. Corrente deve vir de variável de ramo/medição compatível com MNA, nunca de estimativa visual.

## Aceitação

- direção de causalidade é explícita;
- unidade e faixa são validadas;
- não existe leitura de matriz durante execução de worker de sinal;
- loop interdomínio é detectado ou resolvido por política explícita;
- golden compara bridge com circuito equivalente.
