---
id: FEAT-009
kind: feature
status: active
dependsOn: [FEAT-001, ARCH-003, ARCH-006]
supersedes: []
---

# Protocolos industriais

## Escopo

Protocolos são independentes do PLC IEC. Modbus, HART e futuros protocolos usam contratos de transporte/registro próprios e podem ser conectados a instrumentos, sinais ou a variáveis de uma instância PLC por bindings explícitos.

## Contratos

- timeouts usam tempo virtual quando o endpoint é simulado;
- endpoint virtual não abre porta do host implicitamente;
- modo host/network real é opt-in e sujeito ao `ResourceGovernor`;
- registro/variável possui uma única fonte de estado;
- transporte semântico e camada física evoluem separadamente;
- binding PLC ↔ protocolo referencia símbolos/handles compilados, nunca faz busca global por nome no hot path.

## Implementacao entregue na v0.0.26

- `protocol.modbus.server` e `protocol.modbus.client` compartilham um barramento virtual por
  `SimulationSession`, enderecado por canal, unit ID, area e endereco;
- `protocol.hart.transmitter` e `protocol.hart.communicator` compartilham PV, polling address,
  unique ID, tag e unidade no mesmo modelo de isolamento;
- os quatro componentes possuem pinos eletricos `value`/`gnd`, scan e timeout em tempo virtual;
- aparecem em `Process/Protocolos Industriais/Modbus|HART` no catalogo canonico;
- esta entrega e semantica e virtual. Ela nao abre socket, serial, RS-485 nem modem FSK do host e
  nao afirma interoperabilidade fisica; transportes reais continuam opt-in e fora deste marco.

## Ordem

1. registry de variáveis/parameters;
2. Modbus server/client semântico;
3. bindings explícitos Signal/PLC ↔ Modbus;
4. HART semântico;
5. camadas físicas quando justificadas por caso de uso/benchmark.

## Aceitação

- determinismo sob aceleração/pausa para endpoints simulados;
- isolamento de namespace/portas entre sessões;
- golden de timeout e mapeamento de registros;
- PLC funciona sem qualquer protocolo habilitado;
- protocolo funciona sem exigir uma instância PLC;
- nenhuma porta real é criada sem configuração explícita.
