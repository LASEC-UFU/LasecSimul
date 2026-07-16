# ESP32 OpenETH + internet no LasecSimul

Para compilar com PlatformIO usando `setup()`/`loop()` e bibliotecas Arduino,
consulte [`PLATFORMIO_ARDUINO.md`](PLATFORMIO_ARDUINO.md).

Este exemplo usa a pilha `esp_netif`/lwIP real do ESP-IDF sobre o MAC virtual
OpenETH. O modo de rede padrão agora é `lab-bridge`, que conecta a interface a
uma TAP previamente provisionada e permite obter IP do DHCP real da LAN. Para
usar o backend SLIRP do QEMU (DHCP, DNS e NAT sem permissão de administrador),
configure `lasecsimul.network.mode` como `isolated`.

## Requisito

Use ESP-IDF **5.1.x**. A opcao `CONFIG_ETH_USE_OPENETH` e o driver
`esp_eth_mac_new_openeth()` existem nessa serie e sao destinados ao QEMU. Essa
opcao pertence ao firmware; ela nao e uma opcao de linha de comando do QEMU e
nao transforma chamadas `WiFi.begin()` em Ethernet.

## Compilar

Em um terminal ESP-IDF:

```powershell
idf.py set-target esp32
idf.py build
```

O QEMU/LasecSimul recebe uma imagem de flash completa, e nao apenas o binario
da aplicacao. Gere-a com os offsets mostrados por `idf.py build`:

```powershell
python -m esptool --chip esp32 merge_bin -o build/lasecsimul-openeth-flash.bin `
  --flash_mode dio --flash_size 4MB `
  0x1000 build/bootloader/bootloader.bin `
  0x8000 build/partition_table/partition-table.bin `
  0x10000 build/lasecsimul_openeth_internet.bin
```

No LasecSimul, selecione
`build/lasecsimul-openeth-flash.bin` em **Carregar firmware** e inicie a
simulacao. O monitor UART0 deve registrar:

- no modo `lab-bridge`, aquisição de IP, gateway e DNS fornecidos pela rede real;
- no modo `isolated`, IP `10.<namespace>.<instancia>.15`, gateway `.2` e DNS `.3`;
- resolução DNS de `example.com`;
- uma linha de resposta HTTP.

Por padrao, o namespace e escolhido automaticamente por processo LasecSimul.
Em thin clients, configure `lasecsimul.network.namespace` nas configuracoes do
VS Code com um numero exclusivo de `0` a `255` para cada aluno. Reinicie a
janela do VS Code depois de alterar esse valor.

O backend e isolado por processo: oferece conexoes de saida para a internet,
mas nao expoe a ESP32 para a LAN nem abre portas de entrada no computador.
