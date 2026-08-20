(* Fixture minima de smoke test para o pipeline STruCpp (F9.1) -- ver scripts/test-strucpp-smoke.js.
   Um TON simples com uma entrada/saida digital: prova que o compilador vendorizado aceita um
   PROGRAM real e que o resultado usa TIME()/__CURRENT_TIME_NS (tempo simulado), nao wall clock. *)
PROGRAM hello
VAR_INPUT
    di0 : BOOL;
END_VAR
VAR_OUTPUT
    do0 : BOOL;
END_VAR
VAR
    timer0 : TON;
END_VAR

timer0(IN := di0, PT := T#500ms);
do0 := timer0.Q;

END_PROGRAM
