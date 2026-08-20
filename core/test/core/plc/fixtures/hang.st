(* Fixture pro teste "worker preso em loop ST infinito e encerrado por timeout" (F9.4) -- sintaxe
   confirmada manualmente contra o binario vendorizado da STruCpp antes de escrever este arquivo
   (compila sem erro). O loop nunca termina de proposito -- run() jamais retorna, entao qualquer
   SCAN mandado pro worker deve estourar o timeout do lado do PlcRuntime, nunca travar o Core. *)
PROGRAM hangtest
VAR_INPUT
    di0 : BOOL;
END_VAR
VAR_OUTPUT
    do0 : BOOL;
END_VAR
WHILE TRUE DO
    do0 := di0;
END_WHILE;
END_PROGRAM
