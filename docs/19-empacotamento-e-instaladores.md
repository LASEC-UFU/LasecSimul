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

- O Windows hoje gera `.exe` nativo; ainda nao ha `.msi`.
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
