# Migração da biblioteca de controle: persistência e validação

## Ciclo de migração

1. Na abertura de `.lsproj` e `.lssubcircuit`, o conversor detecta tipos legados no diagrama principal, em definições internas e em manifestos incorporados.
2. O documento convertido é validado pelo caminho normal de carregamento. A conversão não altera o arquivo de entrada em memória.
3. Antes de persistir, o original é copiado para `lasecsimul-migration-backup/` ao lado do documento. A cópia é relida e seu SHA-256 deve ser igual ao original. Backups existentes não são sobrescritos; um backup idêntico é reutilizado e conteúdo diferente recebe sufixo.
4. O documento é gravado por substituição atômica. O JSON de relatório inclui regras, IDs, avisos, mapeamentos de overrides e hashes do original e do documento migrado.
5. Uma segunda abertura de documento migrado não cria nova conversão.

Os sistemas externos seguem o mesmo backup e relatório. Se não houver permissão para gravar o manifesto externo, o registro usa uma cópia convertida em memória. Falha ao salvar o projeto principal mantém o documento convertido aberto e marcado como não salvo; falha isolada ao gravar o relatório é informada sem marcar o documento salvo como pendente.

## Auditoria estrutural

`npm test` inclui `migration.test.ts`, que verifica regras para os 31 typeIds históricos, expressões existentes, fios/portas, overrides, conversão determinística, idempotência e persistência com backup verificado. Na aplicação desta migração, os 128 documentos ativos do repositório foram examinados; 102 precisavam ser regravados. Todos os 1.080 blocos convertíveis foram convertidos, 22 acumuladores foram renomeados, 176 `control.constant` foram mantidos por serem parâmetros de modelo específicos e nenhum componente foi recusado. Os originais dos 102 arquivos estão preservados em `lasecsimul-migration-backup/` com hash conferido; o manifesto agregado está em `docs/data/control-full-conversion.json`. A pasta de projetos adicional solicitada tinha 48 documentos; 44 foram migrados (1.017 conversões, 8 renomeações e 205 constantes mantidas), e 13 `control.tank` em 9 projetos foram convertidos pelo fluxo do serializador. Todos os 44 arquivos têm backup e relatório por arquivo.

## Comparação numérica antes/depois

O executor `extension/src/migration/controlLibrary/validateMigration.ts` lê arquivos versionados no commit anterior à nova biblioteca (`ab4c1efb7`), executa o Core legado congelado e o Core atual com os mesmos estímulos, registra saídas do diagrama e dos blocos convertidos, e compara timestamps, cobertura de amostras, valores não finitos, erro absoluto/relativo, RMSE e eventos. Canais ausentes ou amostras sem correspondência são divergência, não são descartados.

Comandos (executar a partir de `extension/`):

```powershell
npm run compile
node out/migration/controlLibrary/validateMigration.js --seconds 40
```

Opções: `--only <parte do caminho>` restringe a execução; cada `--skip <parte do caminho>` exclui um subconjunto; `--append` mescla o lote ao artefato existente por arquivo/diagrama; `--legacy <executável>` e `--current <executável>` selecionam os Cores; `--out <arquivo>` troca o artefato de saída. Por padrão, os executáveis vêm de `core/build-legacy-reference/bin/` e `core/build-main/Release/`. Esses builds precisam representar a revisão legada e o código atual, respectivamente.

Para os wrappers elementares, a grade de comparação deve incluir pelo menos duas atualizações do bloco. O lote atual (`--seconds 0.4 --grid-ms 10`) cobre 24 diagramas: 17 `identico` e 7 `equivalente`, sem divergências, erros de execução, canais ausentes ou amostras sem correspondência. `control_second_order` está incluído: a comparação revelou e orientou a correção da fase de publicação, confirmando depois resultado `identico`. `control_rate_limiter`, `control_stiction`, `control_pid` e `control_fopdt` passaram em 0,4 s. FOPDT usa um `Transport Delay` inline antes da planta discreta; a comparação integrada confirmou equivalência após corrigir a fase do atraso. Após corrigir `control.observer`, o projeto `laboratorio-calculo.lsproj` foi comparado a 0,1 s/10 ms: `hydraulic_tank` ficou `identico` em 22 sinais, sem erro de ligação; o relatório está em `docs/data/control-project-short.json`.

`library_pid` valida as rotinas de PID e estação de sintonia no Core em vários modos e transições. Os testes de `Transport Delay`/`Discrete Transfer Fcn` cobrem os blocos usados no FOPDT, e a comparação integrada do wrapper também passou. A compilação TypeScript e os oito testes específicos da migração passaram após a correção.

O resultado completo é gravado em `docs/data/control-migration-validation.json`; cada linha contém veredito por arquivo/diagrama, erros de execução, canais ausentes e métricas por sinal. A auditoria só pode ser considerada concluída se não houver resultados `divergente` ou `erro`; resultados `equivalente` precisam respeitar as tolerâncias codificadas no validador.
