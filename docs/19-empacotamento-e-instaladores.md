# Empacotamento e instaladores

## Objetivo

Este documento descreve o fluxo de release do LasecSimul para distribuicao fora do monorepo,
incluindo:

- extensao VS Code empacotada por plataforma (`.vsix`);
- instalador nativo Windows (`.exe`);
- pacote nativo Linux (`.deb`);
- Core nativo e bibliotecas ABI/QEMU/subcircuitos embutidos no payload final.

## Artefatos gerados

O workflow [`package-installers.yml`](../.github/workflows/package-installers.yml) produz, por
plataforma:

### Windows

- `lasecsimul-<versao>-win32-x64.vsix`
- `lasecsimul-<versao>-win32-x64-setup.exe`
- `SHA256SUMS.txt`

### Linux

- `lasecsimul-<versao>-linux-x64.vsix`
- `lasecsimul-vscode-extension_<versao>_amd64.deb`
- `SHA256SUMS.txt`

## Como o pacote e montado

O `.vsix` continua sendo o payload canonico da extensao. Ele agora sai do CI ja contendo um layout
embutido com tudo que o runtime precisa:

```text
extension/
  bundled/
    core/build/...
    devices/...
    mcu-adapters/...
    subcircuits/...
    project/schema/component-catalog.json
```

Por isso a extensao foi ajustada para procurar:

- o executavel do Core tanto em `../core/build` quanto em `./bundled/core/build`
- o catalogo tanto em `../project/schema/component-catalog.json` quanto em
  `./bundled/project/schema/component-catalog.json`

No pacote distribuido, o `component-catalog.json` embutido tem `deviceLibraries` reescrito para:

- `./bundled/devices/library.json`
- `./bundled/mcu-adapters/library.json`
- `./bundled/subcircuits/library.json`

## Instalador Windows

O instalador Windows e um `.exe` nativo, gerado a partir de um bootstrapper .NET single-file em
[`packaging/windows-bootstrapper/`](../packaging/windows-bootstrapper/).

Comportamento:

1. extrai o `.vsix` embutido para `%LocalAppData%\LasecSimul\InstallerPayload\`
2. tenta localizar a CLI do editor nestes lugares:
   - `LASECSIMUL_CODE_CLI`
   - `PATH`
   - instalacoes padrao de VS Code, VS Code Insiders e VSCodium
3. executa `code --install-extension <vsix> --force` ou equivalente
4. se a infraestrutura global (TAP/bridge/gateway) estiver ausente ou incompleta, pergunta no
   console se o usuário deseja instalá-la agora (modo `lab-bridge`) ou pular essa etapa e seguir
   apenas com o modo `isolated` (sem TAP nem administrador)
5. só solicita elevação UAC para a etapa de rede se o usuário confirmar a pergunta acima
6. instala o TAP-Windows6 9.27.0 assinado e cria `LasecSimul TAP`
7. seleciona a interface Ethernet física e cria/atualiza a Windows Network Bridge
8. instala `LasecSimul.NetworkGateway.exe` em `Program Files` e registra uma tarefa de inicialização
   como SYSTEM; todos os QEMUs usam o switch central em `127.0.0.1:9011`

O mesmo instalador pode ser executado por todos os usuários do servidor. Depois de instalar o VSIX
no perfil atual, ele verifica a instalação de máquina. Quando TAP, bridge, gateway, tarefa, porta
9011, configuração e entrada de desinstalação estão saudáveis, encerra sem UAC e sem reiniciar o
gateway. Se a infraestrutura estiver ausente ou incompleta, pergunta ao usuário antes de solicitar
UAC e instalar/reparar a etapa global; recusar a pergunta não afeta a instalação da extensão.

A pergunta pode ser respondida antecipadamente por linha de comando, útil para automação:

- `--install-tap`: confirma a instalação da infraestrutura de rede sem perguntar
- `--no-tap` / `--skip-tap`: recusa a infraestrutura de rede sem perguntar
- `--quiet`: também confirma automaticamente (mantém o comportamento anterior a esta pergunta)

## Instalação da infraestrutura de rede a partir da extensão publicada no Marketplace

O Marketplace do VS Code só hospeda o `.vsix` -- não há como publicar o `.exe` nativo lá, e ele
nunca poderia rodar `pnputil`/`netsh bridge`/`schtasks` de dentro do fluxo de instalação de extensão.
Por isso, quem instala o `.vsix` direto do Marketplace (em vez de usar o `.exe`) e configura
`lasecsimul.network.mode: "lab-bridge"` recebe a oferta de instalação pela própria extensão, em
[`src/network/machineNetworkSetup.ts`](../extension/src/network/machineNetworkSetup.ts):

1. na ativação (`onStartupFinished`), só age no Windows e só quando o modo configurado é
   `lab-bridge` (o padrão `disabled` e o modo `isolated` nunca precisam de TAP)
2. detecta a ausência de `%ProgramData%\LasecSimul\network.json` (checagem leve, sem elevação) e
   pergunta ao usuário via notificação nativa do VS Code -- "Instalar agora" / "Mais tarde" / "Não
   perguntar novamente" (a recusa é lembrada por versão da extensão em `globalState`)
3. com consentimento, baixa `lasecsimul-<versão>-win32-x64-setup.exe` e `SHA256SUMS.txt` da release
   `vX.Y.Z` do GitHub (`josuemoraisgh/LasecSimul`, a MESMA versão da extensão em execução) e confere
   o SHA-256 antes de executar
4. roda o `.exe` baixado só com `--provision-network` (nunca sem argumentos: a extensão já está
   instalada por definição, este passo cobre apenas TAP/bridge/gateway), elevando via
   `powershell -Command "Start-Process ... -Verb RunAs -Wait"` -- Node não tem equivalente direto de
   `ProcessStartInfo.Verb = "runas"`

Também existe o comando manual **LasecSimul: Install Network Bridge (TAP Driver)** (Command Palette,
`lasecsimul.network.installMachineSetup`) para repetir esse fluxo a qualquer momento, inclusive
depois de "Não perguntar novamente".

Pré-requisito: a release `vX.Y.Z` correspondente precisa existir publicamente no GitHub com os dois
arquivos acima anexados -- exatamente o que `scripts/package-release.js` gera e o workflow
`package-installers.yml` publica. Repositório precisa ser público: download de asset de release
privada sem token autenticado retorna 404.

A remoção da extensão no VS Code afeta somente o perfil daquele usuário. A infraestrutura global é
registrada separadamente como **LasecSimul — Componentes da Máquina** em Aplicativos/Painel de
Controle. A desinstalação global exige administrador, para o gateway, remove sua tarefa, desfaz
somente a bridge que o LasecSimul criou (ou retira sua TAP de uma bridge preexistente) e remove o
adaptador. O pacote TAP-Windows permanece no Driver Store para não quebrar OpenVPN ou outro software
que compartilhe o mesmo driver.

O workflow baixa `dist.win10.zip` e o arquivo-fonte da tag oficial, exige os SHA-256 fixados no
script, descarta `devcon.exe` e embute somente INF/CAT/SYS, GPLv2, avisos e fonte correspondente.
Também valida a assinatura Microsoft do `tap0901.sys` e executa o self-test multi-cliente do gateway.

Se a CLI nao for encontrada, o instalador falha com mensagem clara e informa onde o `.vsix` foi
extraido.

## Pacote Linux

O Linux recebe um `.deb` real, montado com `dpkg-deb`.

Layout do pacote:

- `/opt/lasecsimul-vscode-extension/`
  - `.vsix`
  - `install-extension.sh`
- `/usr/bin/lasecsimul-install-vscode-extension`

Comportamento:

1. o `postinst` tenta instalar automaticamente a extensao via CLI do editor
2. se a CLI nao estiver disponivel, o pacote continua instalado e orienta o usuario a rodar:

```bash
/usr/bin/lasecsimul-install-vscode-extension
```

O helper aceita override por:

```bash
LASECSIMUL_CODE_CLI=/caminho/para/code /usr/bin/lasecsimul-install-vscode-extension
```

## Fluxo local

Pre-requisitos:

1. Node.js 18+
2. CMake 3.20+
3. compilador C++20
4. .NET SDK 10+ para gerar o `.exe` no Windows
5. `dpkg-deb` para gerar o `.deb` no Linux
6. acesso a rede no primeiro configure do Core por causa do `FetchContent`

Passos:

```powershell
npm --prefix extension ci
npm --prefix extension run compile
node scripts/build-core.js --clean --config Release
node scripts/build-devices.js --clean --config Release
node scripts/build-mcu-adapters.js --clean --config Release
npm --prefix extension test
node scripts/test-core.js --config Release
node scripts/package-release.js
```

Saida:

- `dist/release/win32-x64/` quando rodado no Windows
- `dist/release/linux-x64/` quando rodado no Linux

## Workflow de CI

O workflow faz:

1. checkout
2. setup do .NET no job Windows
3. setup do Node.js
4. install/compile da extensao
5. build do Core, devices e MCU adapters em `Release`
6. testes da extensao
7. testes do Core
8. geracao do `.vsix`
9. geracao do instalador nativo da plataforma
10. upload dos artifacts

Triggers atuais:

- `workflow_dispatch`
- push de tag `v*`

## Observacoes e limites conhecidos

- O Windows gera `.exe` nativo com provisionador SetupAPI; ainda nao ha `.msi`.
- O Linux hoje gera `.deb`; ainda nao ha `.rpm`.
- O fluxo limpa `registeredSources` no catalogo embutido para nao levar registros locais de
  desenvolvimento para o release.
- O payload nativo instalado continua sendo a extensao VS Code; o instalador so automatiza a
  distribuicao e a invocacao da CLI do editor.

## Proximos passos possiveis

- adicionar um `Bundle/MSI` no Windows sobre o mesmo payload
- adicionar `.rpm` no Linux
- publicar artifacts direto em GitHub Releases
- assinar os instaladores nativos
