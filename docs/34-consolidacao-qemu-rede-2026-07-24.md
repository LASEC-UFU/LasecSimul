# Consolidação do QEMU e da rede — 2026-07-24

## Conclusão

A única árvore-fonte do QEMU é `C:\SourceCode\qemu_lasecSimul`. A pasta
`C:\SourceCode\qemu_lasecSimul-build-network` não era uma segunda versão do código: era um
diretório Meson/Ninja sem `.git`, configurado com
`SRC_PATH=/c/SourceCode/qemu_lasecSimul`. Portanto, a aparente divergência foi uma confusão entre
fonte e artefato de build.

A implementação de rede já estava no fonte oficial, preservada pelo commit `d4b1f77`. Os commits
posteriores também estavam na mesma árvore e não alteraram nem removeram os arquivos centrais da
rede. O estado não commitado restante da arena foi revisado e preservado no commit QEMU
`bc2e13d`.

## O que a correção de rede faz

O commit `d4b1f77` contém, entre outras integrações:

- `hw/net/opencores_eth.c`: inicializa um MAC padrão válido, copia o MAC para os registradores
  OpenCores no reset e publica a identificação da NIC. Isso evita que tráfego unicast seja
  descartado por registradores MAC zerados.
- `hw/xtensa/esp32.c` e `hw/xtensa/esp32-simul.c`: criam as NICs solicitadas em `nd_table`, com
  suporte a `model=open_eth` e `model=esp32_wifi`, inclusive coexistência.
- `hw/xtensa/meson.build`: mantém as máquinas ESP32 normal e integrada ao SimulIDE no build.
- `tests/qtest/esp32-network-test.c` e `tests/qtest/meson.build`: cobrem registradores MAC, reset
  e coexistência OpenETH/Wi-Fi nas plataformas onde qtest é habilitado.
- `docs/system/target-xtensa.rst`: documenta SLIRP, socket/stream, `hostfwd` e sub-redes.
- guardas de arena nula em `softmmu` e periféricos: permitem usar a máquina ESP32 como QEMU
  convencional, sem uma arena do Core.

O Core preserva os três modos:

- `disabled` (padrão): não cria NIC;
- `isolated`: `-nic user,model=open_eth,...`, usando libslirp;
- `lab-bridge`: `-nic socket,model=open_eth,connect=127.0.0.1:<porta>`, com fallback para SLIRP
  quando o gateway não está disponível.

Cada instância recebe MAC e sub-rede estáveis e isolados. A Extension propaga
`LASECSIMUL_NETWORK_MODE`, `LASECSIMUL_NETWORK_NAMESPACE` e `LASECSIMUL_GATEWAY_PORT` ao Core.

## Diferenças encontradas

### Fonte oficial

`C:\SourceCode\qemu_lasecSimul` possui:

- repositório Git, branch `main`;
- fonte completo, documentação e testes;
- correção de rede em `d4b1f77`;
- mudanças posteriores:
  - `2ea68be`: período do heartbeat escalado com o shift de icount;
  - `ee4775f`: icount não dividido entre CPUs paradas;
  - `12f645a`: liberação do BQL durante espera da arena;
  - `823f588`: cache de salto por vCPU ampliado;
  - `51fa7b6`: fila circular PERF-13;
  - `bc2e13d`: ordenação de memória entre processos e publicação unificada de eventos.
- build oficial `build-ucrt64`, configurado com `--enable-gcrypt --enable-slirp`.

### Antiga pasta `-build-network`

A pasta possuía somente:

- arquivos gerados por Meson/Ninja;
- objetos e executáveis compilados;
- uma cópia de runtime/toolchain MSYS2;
- configuração apontando para a árvore oficial;
- um executável de 18/07/2026, SHA-256
  `E5BEF521ACE9EB4BEAA8A7FA48B5DD6A481541004A6D16F105C0F1A5003C4669`.

Ela não possuía Git nem cópia independente de `hw/net`, `hw/xtensa`, `softmmu` ou dos testes. Os
arquivos `.c/.h` encontrados fora do toolchain eram gerados pelo build. Assim, não havia patch
exclusivo a transplantar nem conflito de fontes a resolver.

As duas configurações habilitavam `xtensa-softmmu`, gcrypt e slirp. As diferenças relevantes eram
o caminho relativo usado para chegar ao mesmo fonte e o `PATH` capturado no momento da
configuração.

## Consolidação e referências

Foi mantida como única pasta oficial:

`C:\SourceCode\qemu_lasecSimul`

Foi criado `scripts/build-qemu-windows.ps1` e o comando `npm run build:qemu:windows`. O script:

1. exige que o diretório seja um repositório Git;
2. valida que `build-ucrt64/config-host.mak` aponta para a árvore informada;
3. exige `--enable-slirp`;
4. recusa alterações rastreadas ainda não preservadas no Git;
5. compila em shell MSYS2 UCRT64 de login;
6. prepara o executável e suas DLLs em `run-ucrt64`;
7. implanta em `devices/qemu-esp32/bin`;
8. grava commit e SHA-256 em `BUILD-PROVENANCE.txt`;
9. verifica que o hash implantado é idêntico ao build.

O executável implantado veio do commit `bc2e13dc0b7cfe276ccb58710f9e22ae9ba610e9` e possui
SHA-256 `4C0F0F654031DC6F35E03FC6CD5774D40428E0A675F04558D21919435B7CE496`.

O Core não aponta diretamente para um diretório de desenvolvimento em produção. Ele usa o
binário vendorizado, que agora tem proveniência verificável no fonte oficial. Testes do Core
também usam esse mesmo caminho, salvo override explícito de diagnóstico.

O pacote VS Code já instalado em
`C:\Users\josuemorais\.vscode\extensions\josuemoraisgh.lasecsimul-0.0.13-win32-x64` ainda
continha o QEMU `A657295913F522202F19F136587F27D33FD1CB5B167CF8FE9BBAF9C61680D5BD`.
Seus 21 arquivos de runtime foram preservados em
`bundled\devices\qemu-esp32\bin.backup-20260724-consolidation` e substituídos pelo runtime
oficial; todos os hashes implantados foram conferidos.

Não foi encontrada referência para `qemu_lasecSimul-build-network` no Core, CMake, scripts,
configurações, tarefas VS Code, variáveis de ambiente, documentação ou testes do projeto.

## Compilações e testes

Executados com sucesso:

- QEMU `qemu-system-xtensa.exe` via Ninja/UCRT64;
- QEMU implantado sem depender do `PATH` do toolchain (`--version` e lista de máquinas);
- smokes de inicialização:
  - OpenETH + SLIRP;
  - `esp32_wifi` + SLIRP;
  - OpenETH e Wi-Fi simultâneos em sub-redes distintas;
- `lasecsimul-core` Release completo;
- adaptador ESP32 nativo;
- `mcu_controller_real_qemu_test`:
  - arena aberta;
  - OpenETH/SLIRP inicializados;
  - fallback `lab-bridge` indisponível para SLIRP;
  - encerramento limpo;
- `qemu_queue_stress_test`: 60 s, 4.890 eventos, maior intervalo 141 ms, nenhuma trava;
- `mcu_restart_stress_test`: 25/25 ciclos, nenhuma falha de inicialização ou trava;
- `session_restart_stress_test`: 15/15 ciclos Scheduler+QEMU;
- `mcu_multiple_controllers_real_qemu_test`: duas instâncias simultâneas e independentes;
- `mcu_blink_long_run_test` com firmware real: 15/15 rodadas; GPIO13 apresentou níveis alto e
  baixo e 26–30 transições por rodada, sem reset inesperado;
- pacote VS Code instalado: três rodadas adicionais do mesmo Blink passaram, com 28–29
  transições, provando também o carregamento das DLLs no caminho realmente executado pelo usuário;
- gateway Windows Release: zero avisos e zero erros;
- gateway `--self-test`: quadro Ethernet de 64 bytes trafegou entre dois clientes usando o framing
  de quatro bytes big-endian do backend socket do QEMU;
- suíte completa da Extension.

O qtest de rede do próprio QEMU é condicionado a plataforma não Windows. Por isso, no Windows a
evidência foi composta pelos três smokes do dispositivo, integração real pelo Core e self-test de
troca de quadros do gateway.

## Arquivo de segurança

Antes de mover, o build antigo foi inventariado:

- 61.330 arquivos;
- 1.777.939.990 bytes (1,656 GiB);
- hashes do executável e de `config.status` registrados em manifesto próprio.

Ele foi movido integralmente, sem exclusão, para:

`C:\SourceCode\_archive\qemu_lasecSimul-build-network-20260718`

A localização antiga deixou de existir. O arquivo contém
`LASECSIMUL_BUILD_SNAPSHOT.txt`, que explica sua origem, configuração, hashes e caráter somente
forense.

## Riscos e observações

- O arquivo `libfdt-1.dll` ainda existe no pacote por histórico, mas o build atual usa
  `--disable-fdt` e o executável não o importa. Ele não participa do runtime consolidado.
- A árvore QEMU está sete commits à frente de `origin/main` nesta data. A consolidação local está
  preservada em commits, mas ainda depende de publicação remota para proteção fora da máquina.
- O alvo CMake global `ALL_BUILD` recompila fontes do Core separadamente em muitos testes e
  benchmarks. Ele foi interrompido depois de confirmar esse comportamento; o executável completo
  `lasecsimul-core` e todos os alvos relevantes à consolidação foram compilados explicitamente e
  passaram.
