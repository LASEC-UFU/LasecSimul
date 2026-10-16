# Malha de validação da sintonia PID

Abra `malha_teste_pid.lsproj`, inicie a simulação e dê duplo clique no bloco `PID de teste`.

A malha fecha pelo grafo de sinais: constante `SP remoto` → `SP` da estação → processo de primeira ordem → `PV` da estação. A saída `MV` da estação alimenta o processo. Duas outras constantes estão ligadas às portas de modo: `A/M` (`1=Auto`, `0=Manual`) e `L/R` (`0=Remoto`, `1=Local`), conforme o `pid_dialog.jsp`. O painel mostra SP/PV/MV ao vivo e os modos efetivos vindos dessas conexões.

No painel, confirme:

- **Auto**: sinal A/M em 1; `MV` é calculada pelo controlador;
- **Manual**: sinal A/M em 0; editar `MV` altera a saída real da estação e a planta;
- **Local**: sinal L/R em 1; `SP` passa a vir do setpoint local da estação;
- **Remoto**: sinal L/R em 0; `SP` acompanha a constante ligada. Edite a constante no esquema para variar o setpoint remoto.

As portas A/M e L/R aceitam sinais analógicos de modo: A/M abaixo de 0,5 = Manual e a partir de 0,5 = Auto; L/R abaixo de 0,5 = Remoto e a partir de 0,5 = Local. No diálogo, os botões de modo também atualizam as constantes conectadas na malha de teste.

O bloco usa `Kc=2`, `Ti=4 s`, `Td=0`, com saída limitada entre 0 e 100%.
