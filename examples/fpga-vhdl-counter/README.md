# Exemplo: Contador de 4 bits em VHDL (FPGA genérico + GHDL)

Circuito de exemplo pra `docs/38-fpga-vhdl-ghdl.md`. Demonstra o **Bloco Programável FPGA
(VHDL/GHDL)**: um bloco `digital.generic_fpga` compila `counter.vhd` de verdade via GHDL e roda em
lockstep com o resto da simulação elétrica.

## O que tem aqui

- `counter.vhd` -- entity `counter` com um contador síncrono de 4 bits (`clk`/`rst`/`count`).
- `counter.lsproj` -- esquemático pronto: o FPGA, um `Clock` (2 Hz) ligado em `clk`, `rst` amarrado
  no terra (contador nunca reseta), e `count(3 downto 0)` cada bit passando por um resistor de
  330 Ω até um LED, com os catodos no terra.

## Como abrir

1. Abra a pasta `examples/fpga-vhdl-counter/` no VS Code com a extensão LasecSimul instalada.
2. Abra `counter.lsproj` (editor customizado do LasecSimul).
3. O GHDL já vem integrado à extensão; nenhuma configuração de PATH/terminal é necessária.
4. Abra **Propriedades** do bloco FPGA -> **Analisar VHDL** (opcional -- as portas já estão
   salvas no `.lsproj`, útil só depois de editar `counter.vhd`).
5. Rode a simulação (▶). Os 4 LEDs devem contar em binário, incrementando a cada segundo (½ período
   do clock de 2 Hz).

Para montar uma nova instância, selecione **Circuit > Digital**, insira **Bloco Programável FPGA**
(ele aparece inicialmente sem pinos) e use **Carregar código VHDL** nas propriedades. A análise de
`counter.vhd` cria dinamicamente `clk`, `rst` e os quatro bits de `count`.

## O que observar

- O clock elétrico normal do esquemático dirige diretamente uma entrada VHDL (`clk`) -- não existe
  um segundo "clock" dentro do VHDL, o Core avança o GHDL em lockstep a cada evento real do
  Scheduler.
- Botão direito no bloco FPGA também expõe **Rodar/Parar/Reiniciar FPGA** e **Ver log do GHDL**.
