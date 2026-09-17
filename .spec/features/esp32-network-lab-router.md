---
id: FEAT-014
kind: feature
status: draft
dependsOn: [ARCH-001]
supersedes: []
---

# Modo de rede `lab-router` da ESP32

## Requisito de aceitação

Com o simulador rodando e um firmware OpenETH que chamou `mdns_hostname_set("aluno42")`, o usuário
abre o browser **no próprio PC que roda o LasecSimul**, digita `http://aluno42.local/` e recebe a
resposta do servidor HTTP embarcado na ESP32. Sem saber, configurar ou digitar IP algum.

Esse é o requisito primário. Tudo mais neste documento existe para sustentá-lo ou para não regredir
o que já funciona.

Requisitos secundários, na mesma topologia:

- qualquer porta TCP/UDP da ESP32 acessível do host pelo nome ou pelo IP, nos dois sentidos;
- ESP32 com acesso à internet, independentemente de o host usar Wi-Fi, cabo, VPN ou 4G;
- várias ESP32 do mesmo projeto se enxergando entre si;
- instalação sem risco de derrubar a conectividade do host.

## Topologia

```text
Windows (browser, resolvedor mDNS)
   |  TAP "LasecSimul TAP"  10.<ns>.0.1/16   (roteada, NUNCA bridged)
   |      +- IP forwarding + New-NetNat --> uplink do host (Wi-Fi, cabo, VPN, 4G)
   v
LasecSimul.NetworkGateway.exe   (switch L2 em user-space, 127.0.0.1:9011)
   +-- QEMU #1  ESP32 "aluno42"  10.<ns>.1.15
   +-- QEMU #2  ESP32 "aluno43"  10.<ns>.2.15
   +-- ...
```

O host e todas as ESP32 compartilham **um único segmento L2**. É essa propriedade — e só ela — que
faz o mDNS funcionar: mDNS é multicast link-local, e o Windows está dentro do link.

O uplink físico nunca transporta os MACs das ESP32; ele só carrega pacotes IP originados pelo
próprio host. Por isso o modo é indiferente a Wi-Fi, que admite um único MAC por estação associada.

## Modos suportados

O enum `lasecsimul.network.mode` passa a ser:

| Modo | Papel |
|---|---|
| `lab-router` | **Padrão.** Topologia acima. Provisionado pelo instalador. |
| `lab-bridge` | Mantido sem alteração. TAP em Windows Network Bridge, ESP32 como dispositivo da LAN física. Exige interface cabeada. |
| `disabled` | Mantido. Nenhuma NIC, socket ou thread de rede. Obrigatório para firmware sem `CONFIG_ETH_USE_OPENETH` (Blink e similares). |

`isolated` sai do enum exposto ao usuário. O código da libslirp em `isolatedOpenEthArgument`
(`core/src/mcu/McuController.cpp`) **não é removido**: continua como alvo interno de degradação (ver
"Degradação"). Projetos salvos com `"isolated"` são migrados para `"lab-router"` na abertura, com
aviso único.

> Decisão pendente de confirmação: `disabled` continua sendo o default **de runtime** para projeto
> novo, enquanto `lab-router` é o que o **instalador provisiona** por padrão. Motivo: um Blink sem
> OpenETH não deve pagar NIC, socket e thread de rede, e uma falha de infraestrutura não pode
> alcançar CPU, GPIO ou boot. Se a intenção for `lab-router` como default de runtime também, é uma
> linha — mas todo firmware passa a instanciar a NIC.

## Provisionamento do host — `ConfigureRoutedTap`

Novo irmão de `ConfigureBridge` em `packaging/windows-bootstrapper/Program.cs`. Reaproveita
integralmente a instalação do driver TAP-Windows6 já existente; diverge a partir do ponto em que
hoje se chama `netsh bridge create`.

1. instalar/garantir a TAP (código atual, inalterado);
2. `New-NetIPAddress -InterfaceAlias "LasecSimul TAP" -IPAddress 10.<ns>.0.1 -PrefixLength 16`;
3. `Set-NetConnectionProfile -InterfaceAlias "LasecSimul TAP" -NetworkCategory Private`;
4. regra de firewall liberando UDP 5353 (entrada e saída) na TAP;
5. habilitar IP forwarding na TAP e no uplink;
6. `New-NetNat -Name LasecSimulNat -InternalIPInterfaceAddressPrefix 10.<ns>.0.0/16`;
7. registrar o gateway como serviço SYSTEM (código atual, inalterado).

O passo 3 é o mais fácil de esquecer e o de sintoma mais enganoso: com a rede classificada como
*Pública*, o firewall descarta as respostas mDNS de entrada, e `ping` no IP funciona enquanto
`.local` não resolve.

Nada aqui toca a interface física. Consequências diretas:

- o Windows nunca move o IP da placa para `BridgeMP`, então **somem** a exigência de DHCP na
  interface física (`PhysicalAdapterUsesDhcp`), a recusa por IPv4 estático e o rollback de 60s de
  `WaitForUsableHostNetwork`. Essas salvaguardas permanecem no código, mas só no caminho
  `lab-bridge`;
- somem também as dependências de rede externa do `lab-bridge`: pool DHCP, port-security, NAC,
  client isolation, multicast entre clientes.

É isso que torna `lab-router` defensável como padrão de instalação, coisa que `lab-bridge` nunca
poderia ser.

### Conflito de `New-NetNat`

O WinNAT admite um número muito restrito de instâncias, e Docker Desktop, WSL2 e Hyper-V costumam
já ocupar uma. O provisionamento deve detectar isso e, em conflito, degradar **sem falhar a
instalação**: sem NAT a ESP32 perde a internet, mas o segmento roteado continua íntegro e o
requisito primário (`.local`, porta 80, host <-> ESP32) continua atendido, porque ele não depende de
NAT. Registrar o aviso e oferecer ICS como alternativa manual.

## Gateway — DHCP no caminho de quadros

O switch L2 de `packaging/windows-network-gateway/Program.cs` **não muda**: `FromClient` já replica
quadros de grupo para os demais QEMUs e para a TAP, e `ReadTapLoop` já faz o inverso. Multicast mDNS
entre host e ESP32 flui pela implementação atual, sem alteração.

Falta só o DHCP, porque cruzando o limite L3 o servidor do laboratório não é mais alcançável.

Implementar **dentro do caminho de quadros**, não como socket UDP: interceptar em `FromClient` os
quadros UDP porta 67 vindos dos clientes e injetar a resposta como quadro. Isso evita disputar a
porta 67 do host e não depende da pilha do Windows.

Endereçamento determinístico, sem persistência de lease: o octeto do slot é extraído do MAC. Para
isso, `openEthMacAddress` passa a codificar namespace e slot em posição fixa —
`02:4c:<ns>:<slot>:<hash16>` — em vez de espalhar o hash FNV por quatro octetos. O gateway decodifica
e serve `10.<ns>.<slot>.15`, máscara `/16`, gateway e DNS `10.<ns>.0.1`. Mesma identidade que o
`isolated` já produzia, agora num segmento único e compartilhado.

## mDNS

**Plano A (esperado, sem código):** o resolvedor mDNS nativo do Windows (`dnscache`, desde a 1703)
consulta em todas as interfaces, inclusive a TAP. Chrome e Edge usam o resolvedor do sistema. Com o
perfil *Privado* e a regra de UDP 5353 no lugar, `aluno42.local` resolve sem nada além disso.

**Plano B (contingência):** se o resolvedor nativo se mostrar instável — há variação com o Bonjour
da Apple instalado e com política corporativa — o gateway ganha um snooper: ele já vê todo o tráfego
mDNS do segmento, monta uma tabela nome->IP e responde DNS unicast em `10.<ns>.0.1:53`, ativado por
`Add-DnsClientNrptRule -Namespace ".local" -NameServers 10.<ns>.0.1`. Unicast atravessa qualquer
coisa. Só implementar se a Fase 0 provar necessário.

**Fora de escopo:** resolver o nome da ESP32 a partir de **outros** PCs da LAN. Isso exigiria
refletor multicast com reescrita de registros A/SRV, ou rota estática no roteador, e não faz parte
do requisito. Quem precisa disso usa `lab-bridge`.

## Degradação

`McuController::start` hoje degrada `lab-bridge` para SLIRP quando o gateway não aceita conexão em
9011, evitando que `qemu_init()` aborte por `ECONNREFUSED`. A mesma proteção passa a valer para
`lab-router`, com o mesmo alvo interno `isolatedOpenEthArgument` — daí a decisão de não apagar esse
código. A ESP32 perde `.local` e a visibilidade mútua, mas mantém NIC, MMIO e internet, e GPIO,
timers e boot seguem intocados.

## Fase 0 — validar antes de construir

Executar manualmente, antes de escrever qualquer código de produção. Todo o restante da spec depende
de o Plano A se confirmar:

1. instalar a TAP pelo instalador atual, recusando a bridge;
2. aplicar à mão os passos 2 a 6 de `ConfigureRoutedTap`;
3. subir o gateway atual, sem modificação;
4. rodar uma ESP32 com IP estático no firmware (`10.<ns>.1.15/16`, gw `10.<ns>.0.1`) e
   `mdns_hostname_set("aluno42")` + servidor HTTP na porta 80;
5. do browser do host: `http://10.<ns>.1.15/`, depois `http://aluno42.local/`.

Passo 4 ok e passo 5 falhando isola o problema em firewall ou resolvedor. Passo 5 ok fecha o
requisito e reduz a spec a empacotamento.

## Testes

- `LasecSimul.NetworkGateway --self-test` ganha caso de DHCP: quadro DISCOVER injetado, ACK esperado
  com `10.<ns>.<slot>.15` derivado do MAC;
- teste de unidade para a codificação/decodificação de `openEthMacAddress`;
- `McuControllerRealQemuTest`: `lab-router` produz argumento `socket,model=open_eth` e degrada para
  SLIRP com gateway ausente;
- teste de migração `isolated` -> `lab-router` no carregamento de projeto;
- validação de que `disabled` continua sem criar NIC, socket ou thread.

## Riscos

| Risco | Mitigação |
|---|---|
| Resolvedor mDNS nativo instável | Fase 0 detecta cedo; Plano B já desenhado |
| Perfil de rede da TAP volta a *Pública* após reinstalação de driver | Serviço do gateway reafirma o perfil na inicialização |
| `New-NetNat` em conflito com Docker/WSL2 | Degradar para roteamento sem NAT; requisito primário preservado |
| Instalação passa a exigir UAC no fluxo padrão | Já exigia para `lab-bridge`; recusar UAC cai em `disabled` sem quebrar a extensão |
