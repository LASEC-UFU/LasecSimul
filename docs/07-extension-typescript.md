# 07 - Extension TypeScript

## Objetivo

Definir responsabilidades da Extension VSCode.

## Escopo

Código em `extension/`, comandos, painéis, webview, projeto e IPC.

## Responsabilidades

- Registrar comandos `lasecsimul.openSchematicEditor`, `lasecsimul.run`, `lasecsimul.pause` e `lasecsimul.stop`.
- Criar e gerenciar Webview.
- Iniciar e encerrar `lasecsimul-core` via `CoreClient`.
- Persistir decisões de confiança de plugins.
- Ler metadados visuais de device quando necessário.
- Salvar e abrir `.lsproj`.

## Proibições

- Não calcular simulação elétrica.
- Não gerenciar QEMU diretamente.
- Não carregar DLL/SO.
- Não abrir pipes/sockets fora de `CoreClient`.
- Não importar arquivos do Core C++.

## Estrutura esperada

- `extension/src/extension.ts`: ativação, comandos e ciclo de vida.
- `extension/src/ipc/CoreClient.ts`: comunicação com Core.
- `extension/src/ipc/types.ts`: tipos de mensagem.
- Comandos da UI continuam registrados em `extension/src/extension.ts`; não existe diretório
  `extension/src/ui/commands/` separado no desenho atual.
- `extension/src/ui/panels/`: criação de painéis.
- `extension/src/ui/webview/`: assets e scripts da UI.
- `extension/src/project/`: serializer `.lsproj`.

## Testes mínimos

- ativação da extensão;
- comando abre Webview;
- Core não inicia e erro é exibido;
- mock de Core responde handshake;
- encerramento limpo fecha processo Core.
