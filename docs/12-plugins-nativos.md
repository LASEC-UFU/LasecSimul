# 12 - Plugins Nativos

## Objetivo

Orientar a implementação e uso de dispositivos customizados nativos.

## Escopo

Plugins DLL/SO em processo, ABI C estável e integração com Core. WASM não faz parte da arquitetura ativa.

## Modelo

- `library.json`: catálogo da biblioteca.
- `.lsdevice`: manifesto de dispositivo.
- `.lsdevice`: manifesto de adapter MCU, quando aplicável.
- DLL/SO/DYLIB: binário nativo com símbolo `lsdn_get_vtable`.
- `PluginModule`: código carregado.
- `NativeDeviceProxy`: instância de dispositivo.
- `NativeMcuAdapterProxy`: instância de adapter MCU.

## Regras ABI

- `extern "C"`.
- Tipos POD de tamanho fixo.
- Sem STL na fronteira.
- Sem exceções atravessando a fronteira.
- Sem RTTI.
- Buffers de saída alocados pelo chamador.
- Ponteiros de parâmetro válidos apenas durante a chamada.
- Versionamento por major/minor.

## Ciclo de vida

1. Extension valida confiança/publisher quando aplicável.
2. Core valida manifesto, hash e ABI.
3. `PluginLoader` carrega o módulo.
4. `GlobalPluginCache` publica versão ativa.
5. `PluginRuntime` cria instâncias para a sessão.
6. `NativeDeviceProxy` chama vtable durante `stamp`/`postStep`.
7. `PluginModule` só descarrega quando a última instância soltar o `shared_ptr`.

## Versioned swap

Atualizar plugin significa carregar nova versão lado a lado. Instâncias existentes continuam no módulo antigo. Novas instâncias usam o módulo novo. Nunca descarregar módulo com instância viva.

## Segurança aceita no MVP

A arquitetura privilegia desempenho. Não há sandbox de memória para plugin nativo. A mitigação é validação, consentimento, crash guard best-effort e reinício do Core quando necessário.
