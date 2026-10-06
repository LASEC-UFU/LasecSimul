# HART no fio do 4–20 mA e o Modem HART

No LasecSimul, o HART passa a ser **um sinal elétrico no laço 4–20 mA**, como
no hardware real. Um transmissor (dispositivo HART padrão, LD301, …) não tem
mais porta serial: um PC só fala com ele por um **Modem HART ligado em série no
laço**.

## Montagem

```
 +24 V ──[ R 250 Ω ]──(L+) MODEM HART (L-)──(LOOP+) TRANSMISSOR (LOOP-)── 0 V
                         │                      │
                     COM do PC              PRESSÃO : sinal do processo (LD301)
                  (PACTware, DTM)
```

- **Fonte**: 24 V (qualquer fonte de tensão).
- **Modem HART** (paleta *Protocolos Industriais › HART*): mesmo aspecto do
  LasecPlot, com LEDs Tx/Rx e botão **Abrir/Fechar** da porta COM. Ele é ligado
  **em série** pelos terminais **L+ / L-** e tem um **resistor interno de 250 Ω**,
  a carga HART. Com ele, o resistor externo é opcional.
- **Transmissor**: terminais **LOOP+ / LOOP-** no laço. No LD301, conecte a
  saída `OUT` de um slider ou da planta à entrada de sinal **PRESSÃO**. O
  dispositivo HART padrão mantém as entradas elétricas **S+ / S-**.
- **PC**: em *Ligação com o PC*, escolha **Serial (COM / CNC)** ou **UDP**.
  - **Serial**: *Porta serial* é uma lista com as portas que existem no PC
    (COMx e as pontas com0com CNCAx/CNCBx). O PACTware/DTM usa a outra ponta do
    par, a 1200 bit/s 8O1.
  - **UDP**: o modem escuta em *Endereço UDP local*:*Porta UDP* (padrão
    127.0.0.1:5094). Cada datagrama recebido é um quadro HART que vai para o
    fio; a resposta volta inteira, num datagrama, para quem enviou.

  Com a simulação rodando, clique em **Abrir** no modem.

## Vários transmissores no mesmo laço (multiponto / polling)

```
 +24 V ──[R 250 Ω]──(L+) MODEM HART (L-)──┬──(LOOP+) LD301 #1 (LOOP-)──┐
                                          ├──(LOOP+) LD301 #2 (LOOP-)──┤
                                          └──(LOOP+) LD301 #3 (LOOP-)──┴── 0 V
```

- **Ligação**: todos os transmissores ficam no **mesmo par de fios**, ou seja,
  em paralelo entre si. Uma fonte, um modem e uma porta serial (ou UDP) atendem
  todos.
- **Endereço de polling**: dê a cada transmissor um *Polling address* diferente
  (1–15).
  - Num transmissor HART 5, como o LD301, endereço ≠ 0 coloca o aparelho em
    multiponto: a corrente fica fixa em 4 mA e o laço passa a medir N × 4 mA
    (3 aparelhos = 12 mA = 3,0 V sobre 250 Ω).
  - Num dispositivo HART 7, desmarque também *Corrente de loop habilitada*.
- **Device ID**: dê a cada um um *Unique ID* diferente (ex.: 000101, 000202…).
  É o endereço longo que o PACTware usa depois da varredura. Duas instâncias
  com o mesmo ID responderiam juntas, gerando colisão, como no campo.
- **Como o mestre encontra os aparelhos**: varre o Comando 0 em quadro curto,
  endereço 0, 1, 2…; só o aparelho daquele endereço responde. Depois usa o
  endereço longo de cada um.
- **Por que não em série**: com os transmissores em série, a corrente do laço
  seria uma só, e cada transmissor é uma fonte de corrente que regula essa
  corrente. Dois em série brigam pelo mesmo valor. Por isso essa montagem não é
  suportada (nem testada); o multiponto HART é sempre no mesmo par de fios.

## O que acontece no fio (Bell 202)

| Sentido | Como é transmitido | Amplitude |
|---|---|---|
| PC → transmissor (pedido) | O modem soma uma **tensão** FSK em série no laço | ≈ 500 mV p-p (propriedade *Amplitude de transmissão*) |
| Transmissor → PC (resposta) | O transmissor soma **±0,5 mA** FSK à sua corrente de 4–20 mA | 1 mA p-p |

- **Codificação**: "1" = 1200 Hz e "0" = 2200 Hz, com fase contínua, a
  1200 bit/s. Cada caractere tem 11 bits (início, 8 dados, paridade ímpar,
  parada), como no HART real.
- **Valor médio**: a portadora tem média zero, então a corrente média continua
  sendo o valor 4–20 mA da variável.
- **Demodulação**: os receptores (modem e transmissor) demodulam **só pela
  forma de onda**. Há detecção de portadora (recebem ≥ 120 mV p-p e ignoram
  ≤ 80 mV p-p), cruzamentos por zero e amostragem no centro de cada bit.
- **Falhas como no hardware**: resistência de carga baixa demais, fio aberto ou
  amplitude insuficiente derrubam a comunicação, como no hardware real.
- **Turnaround**: o transmissor só responde depois que a portadora do mestre
  some, e pelo menos 1 caractere após o fim do pedido. A comunicação é half
  duplex.

## Osciloscópio (ensino)

- **Sobre um resistor de 250 Ω do laço**: aparece a **resposta do
  transmissor**, 1 mA p-p × 250 Ω = **250 mV p-p** de senoide de 1200/2200 Hz
  sobre o nível DC. Com 12 mA, o DC é 3,0 V.
- **Sobre os terminais do transmissor (LOOP+/LOOP-)**: aparece também o
  **pedido do modem**, ≈ 500 mV p-p.

  O pedido não aparece sobre o resistor externo: o transmissor é uma fonte de
  corrente, então a tensão em série do modem não muda a corrente do laço. Esse
  é o comportamento físico de um modem em série.
- **Intervalo de amostra do osciloscópio**: para ver bem a senoide, use 10–20 µs.
  O transmissor e o modem calculam a portadora a cada 20 µs, e o padrão de
  50 µs fica serrilhado.

## Propriedades do Modem HART

| Propriedade | Padrão | Efeito |
|---|---|---|
| Ligação com o PC | Serial | Serial (COM / CNC) ou UDP |
| Porta serial (COM / CNC) | COM1 | escolhida entre as portas do PC (1200 bit/s, 8 bits, paridade ímpar, 1 stop) |
| Endereço UDP local / Porta UDP | 127.0.0.1 / 5094 | onde o modem escuta no modo UDP |
| Abrir automaticamente | não | abre a COM ao iniciar a simulação |
| Resistor interno (carga HART) | 250 Ω | onde a corrente do transmissor vira tensão para o receptor do modem; com valor baixo demais (ex.: 30 Ω) a resposta fica abaixo do limiar e o PC não ouve nada |
| Amplitude de transmissão | 500 mV p-p | amplitude do pedido no fio |

## O que mudou em relação à versão anterior

- **Dispositivo HART padrão e LD301**: não têm mais *Porta serial*, *Baud rate*
  nem *Canal HART*.
- **Porta Serial (COM) e Terminal Serial**: não têm mais o protocolo "HART",
  que entregava quadros direto ao dispositivo.
- **Porta UDP direta** (que entregava quadros ao dispositivo sem passar pelo fio):
  removida da paleta. Projetos antigos ainda abrem, mas o UDP agora é uma opção
  de *Ligação com o PC* do Modem HART, passando pelo fio como a serial.
- **Ferramenta `core/tools/hart_ld301_serial_bridge`**: agora monta o laço
  físico (24 V, 250 Ω, Modem HART na COM e LD301) e roda em tempo real. Uso:
  `hart_ld301_serial_bridge CNCB2` com `python scripts/ld301_serial_check.py COM22`
  do outro lado do com0com.

## Verificação

| Teste | O que prova |
|---|---|
| `hart_physical_layer` | **17 verificações.** Modulação/demodulação de 512 caracteres sem erro com amostragem de 10–50 µs (com jitter), limiar de portadora (130 mV aceito, 60 mV ignorado), 250 mV recebidos sobre 250 Ω e 50 mV perdidos sobre 50 Ω, fim da portadora sem degrau e recorte de quadros |
| `hart_wire_loop` | **25 verificações**. Multiponto: 3 LD301 (endereços 1, 2, 3) num par, 12 mA no laço, cada endereço respondido só pelo seu aparelho, quadro longo só pelo ID certo, endereço vazio sem resposta; modem em UDP com datagramas reais. Além disso, as **16 verificações** do laço simples: numa sessão real com fonte, resistor, modem e LD301. Comandos 0, 1, 3, 13 e 15 respondidos pelo fio, byte a byte iguais ao do transmissor. Osciloscópio: 250 mV p-p no resistor, média DC inalterada, 500 mV p-p nos terminais do transmissor e pedido sem efeito na corrente. Também: endereço errado sem resposta, resistor do modem de 30 Ω sem recepção e transmissor fora do laço sem comunicação |
| `ld301_serial_check.py` pela COM real (com0com) através do modem e do fio | **131 de 135** respostas idênticas à captura do LD301 real; as 4 diferenças são defeitos conhecidos da própria captura |
| Desempenho (Core em Release) | uma transação de 0,4 s simulados leva ≈ 0,2 s de CPU, mais rápido que o tempo real |
