# Referencias visuais TDPS v7.71

Cada PNG deste diretório é a tela correspondente de uma fonte TDPS v7.71
normalizada para 640 px de largura, sem BMPs em runtime. A autoridade de
origem, identidade estável e vínculo imagem/modelo é
`.spec/fixtures/tdps-v771-library.json`; ela cobre todas as fontes auditadas
em `.spec/fixtures/tdps-v771-coverage.json`.

Para regenerar localmente, sem redistribuir o corpus proprietário:

```powershell
./scripts/convert-tdps-reference-images.ps1 -TdpsSourceRoot C:\caminho\para\TDPSv771\examples
$env:TDPS_SOURCE_ROOT = 'C:\caminho\para\TDPSv771\examples'
node ./scripts/generate-tdps-process-library.mjs
```

Os `.lssubcircuit` usam `background.asset` relativo, que é empacotado como
`data:image/png;base64` pelo catálogo canônico. A imagem é somente a
referência visual: topologia, pinos e `exposedComponents` permanecem
declarativos e executados pelo mesmo Signal Graph dos demais processos.
