# Componentes externos, Device referenciado e persistência — 2026-07-17

## Taxonomia

A paleta mostra `Device` e `Subcircuito` diretamente em `Externos` (`External` em inglês), sem
subpastas. Os diretórios físicos `Devices` e `Subcircuitos` existem apenas no armazenamento interno
dos arquivos importados. Fontes e projetos antigos continuam resolvidos por `typeId` e caminho.

## Dois fluxos distintos

`Device`, em `Externos`, é um contêiner por referência. Depois de inseri-lo, a propriedade
**Arquivo do Device** escolhe um `.lsdevice`. O projeto grava `deviceRef.path`, `typeId`, pinos
conhecidos e data da última carga. Ao abrir o projeto novamente, a extensão relê o manifesto e
recarrega biblioteca nativa ABI ou adaptador MCU/QEMU. Um watcher recarrega automaticamente a
instância quando o arquivo muda, é recriado ou removido. Caminho ausente, JSON inválido ou ABI
incompatível mantém um placeholder selecionável e
mostra diagnóstico, sem corromper o esquema.

**Adicionar componente externo** é permanente para a instalação atual. O comando aceita somente
`.lsdevice` e `.lssubcircuit`, detecta o tipo, valida a estrutura, o `typeId`, dependências de arquivo
e de componentes, copia o pacote para o armazenamento da extensão em `Externos/...` e atualiza a
paleta imediatamente. `typeId` duplicado é recusado. Esse fluxo não deve ser confundido com o
`Device` por referência.

## Persistência e edição

- `Salvar` escreve no arquivo atual; se o projeto ainda não tem caminho, usa o fluxo de
  `Salvar como...`.
- `Salvar como...` sempre abre o seletor, mesmo quando já existe arquivo atual.
- Posição e rotação do rótulo (`__ui_idLabelX`, `__ui_idLabelY`, `__ui_idLabelRotation`) são
  propriedades do componente. Assim elas acompanham seleção, movimento, cópia/cola, rotação,
  espelhamento, serialização e reabertura do VS Code.
- O botão **Configurações** abre a página da extensão; falhas são registradas e exibidas ao usuário.

## Geometria de terminais

O terminal elétrico canônico é sempre `package.pins[].x/y`. O renderizador, hit-test, âncoras de fio
e transformações usam a mesma conversão de geometria. Somente pacotes legados explicitamente
marcados com `leadOrigin: "body"` recebem tradução de origem. A auditoria automatizada percorre todos
os `.lsdevice` e `.lssubcircuit`, valida limites e pinos e aplica rotações e espelhamentos.

## Verificação automatizada

Os testes cobrem política de salvar, round-trip de rótulos e `deviceRef`, validação/cópia de
componentes externos, estrutura da paleta, manifesto de comandos e auditoria geométrica completa.
O processo de release inclui `Externos` no VSIX para que a estrutura verificada seja a mesma da
instalação distribuída.
