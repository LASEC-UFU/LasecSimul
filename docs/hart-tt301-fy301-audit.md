# TT301 e FY301: base visual e diferenças para a próxima coleta

Os dois dispositivos usam os SVGs fornecidos em `ld301/tt301.svg` e
`ld301/Fy301.svg`, copiados para `subcircuits/` para entrar no pacote da
extensão. O esquemático mostra o LCD dinâmico acima de cada imagem, com a
mesma moldura compacta do LD301. Os quatro IDs de pino do Core são preservados:
`sensor_plus`, `sensor_minus`, `loop_plus` e `loop_minus`.

## TT301

- O manual `ld301/tt301mp.pdf`, página PDF 11 (seção 1.3), identifica os
  bornes superiores +/− para alimentação de 12 a 45 Vcc e os bornes inferiores
  1 a 4 para sensores. TEST permite medir a corrente sem abrir o laço e COMM
  recebe o configurador HART.
- As páginas PDF 20–21 descrevem RTDs de 2, 3 ou 4 fios. A página 21 informa
  que o display pode alternar duas variáveis a cada três segundos.
- Nesta base, `LOOP+/LOOP-` são os bornes do laço. `S+/S-` continuam sendo a
  entrada diferencial de tensão existente no Core, e ainda não representam os
  quatro bornes 1–4, as resistências de linha nem os tipos de sensor reais.

## FY301

- O manual `ld301/fy301mp.pdf`, páginas PDF 16–18, mostra os bornes do sinal
  4–20 mA, TEST, COMM e terra. O posicionador apresenta impedância equivalente
  aproximada de 550 Ω, segundo a página 18.
- A página PDF 22 descreve a opção especial K2 de retorno de posição em
  corrente com quatro bornes. Essa opção não deve ser presumida no FY301 padrão.
- As páginas PDF 25–28 descrevem o transdutor pneumático, a realimentação
  interna por sensor de posição e o LCD. Em operação normal, o LCD indica a
  posição da válvula em porcentagem; o setpoint pode ser selecionado.
- Nesta base, `LOOP+/LOOP-` identificam o laço HART. `POS+/POS-` são entradas
  virtuais de posição exigidas pelo modelo elétrico atual do Core; não são
  bornes físicos do FY301 padrão. O Core ainda modela o laço como saída de
  corrente de transmissor, enquanto o FY301 real recebe o sinal 4–20 mA.

## Próxima etapa de fidelidade

Capturar em cada equipamento: identificação HART e comandos suportados,
resposta do LCD em repouso e nas mudanças de variável, polaridade e grandezas
nos bornes, efeito de alimentação/ausência de sinal, e comportamento de
entrada/saída. Para o TT301, cobrir os sensores de 2/3/4 fios; para o FY301,
posição, setpoint e portas pneumáticas. Essas medições orientarão a troca dos
terminais virtuais por modelos físicos sem inventar comportamento de hardware.
