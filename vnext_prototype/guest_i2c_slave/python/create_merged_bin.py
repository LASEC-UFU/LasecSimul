# python/create_merged_bin.py
#
# Script de pos-build do PlatformIO (extra_scripts) para ambientes ESP32.
#
# O que ele faz:
#   1. Descobre o ambiente ativo (PIOENV) e a pasta de build correspondente.
#   2. Localiza bootloader.bin, partitions.bin e firmware.bin gerados pelo
#      PlatformIO, usando os offsets reais calculados para o projeto
#      (com fallback para os offsets padrao do ESP32 caso necessario).
#   3. Concatena tudo em ".pio/build/<env>/merged.bin", no mesmo formato
#      usado pelo SimulIDE (validado contra o exemplo "Devkitc_test" que
#      acompanha a instalacao do simulador).
#   4. Copia o "esp32.efuse" do SimulIDE para "merged.efuse", pois e assim
#      que o simulador associa o arquivo de efuse ao binario do projeto.
#
# Basta declarar, em platformio.ini:
#   extra_scripts = post:python/create_merged_bin.py
# Nenhuma configuracao manual adicional e necessaria.

Import("env")

import os
import shutil
from pathlib import Path

# -----------------------------------------------------------------------
# Valores padrao, usados somente quando o PlatformIO nao informa offsets
# especificos do projeto. Correspondem ao layout de flash convencional
# do ESP32 (Arduino/ESP-IDF) e ao que foi observado no merged.bin de
# referencia do SimulIDE.
# -----------------------------------------------------------------------
DEFAULT_OFFSETS = {
    "bootloader.bin": 0x1000,
    "partitions.bin": 0x8000,
    "firmware.bin": 0x10000,
}
DEFAULT_FLASH_SIZE = 0x400000  # 4 MB: tamanho de flash mais comum do ESP32

DEFAULT_SIMULIDE_DIR = r"C:\Program Files\ININDUFU\SimulIDE_2-R260501_Win64"
EFUSE_RELATIVE_PATH = Path("data") / "bin" / "esp32" / "esp32.efuse"

LOG_PREFIX = "[create_merged_bin]"


def _log(message):
    print(f"{LOG_PREFIX} {message}")


def _warn(message):
    print(f"{LOG_PREFIX} AVISO: {message}")


def _fail(env, message):
    # Interrompe o "pio run" com uma mensagem de erro clara, do mesmo
    # jeito que o proprio builder do PlatformIO faz em erros fatais.
    print(f"{LOG_PREFIX} ERRO: {message}")
    env.Exit(1)


def _parse_int_auto(value):
    """Converte '0x1000', '4096' (str) ou int para inteiro."""
    if isinstance(value, int):
        return value
    return int(str(value).strip(), 0)


def _parse_app_offset(env):
    """Le o offset real do firmware calculado pelo PlatformIO a partir da
    tabela de particoes do projeto (variavel ESP32_APP_OFFSET). Se a
    variavel nao existir, usa o offset padrao 0x10000."""
    raw = env.subst("$ESP32_APP_OFFSET")
    if raw and raw.strip().lower() not in ("", "none"):
        try:
            return _parse_int_auto(raw.strip())
        except ValueError:
            _warn(f"ESP32_APP_OFFSET invalido ('{raw}'); usando 0x10000.")
    return DEFAULT_OFFSETS["firmware.bin"]


def _parse_flash_size(value):
    """Converte tamanhos como '4MB'/'2MB'/'1024KB' (formato usado nos
    arquivos de definicao de placa do PlatformIO) para bytes."""
    if not value:
        return DEFAULT_FLASH_SIZE
    text = str(value).strip().upper()
    try:
        if text.endswith("MB"):
            return int(text[:-2]) * 1024 * 1024
        if text.endswith("KB"):
            return int(text[:-2]) * 1024
        return _parse_int_auto(text)
    except ValueError:
        _warn(f"upload.flash_size invalido ('{value}'); usando 4MB.")
        return DEFAULT_FLASH_SIZE


def _resolve_simulide_dir():
    """Resolve o diretorio base do SimulIDE: variavel de ambiente
    %SIMULIDE%, ou o caminho padrao de instalacao caso ela nao exista."""
    env_value = os.environ.get("SIMULIDE")
    if env_value:
        return Path(env_value)
    return Path(DEFAULT_SIMULIDE_DIR)


def _collect_flash_images(env, build_dir):
    """
    Monta o mapa {offset: caminho_do_arquivo} com tudo que sera gravado
    no merged.bin.

    Fonte primaria: a lista FLASH_EXTRA_IMAGES, que o proprio PlatformIO
    calcula para a placa/ambiente atual (bootloader, tabela de particoes,
    boot_app0/otadata e quaisquer imagens extras especificas da placa).
    Usar essa lista garante que offsets customizados no projeto sejam
    respeitados automaticamente, sem precisar adivinhar nada aqui.

    Fallback: caso essa lista nao exista (ex.: outra versao/fork da
    plataforma), procura bootloader.bin/partitions.bin pelo nome dentro
    da propria pasta de build, usando os offsets padrao do ESP32.

    Retorna (images, bootloader_path, partitions_path, firmware_path).
    Os tres ultimos sao os caminhos *esperados* dos arquivos obrigatorios
    (podem nao existir ainda; a validacao de existencia e feita depois).
    """
    images = {}
    bootloader_path = None
    partitions_path = None

    for offset_raw, path_raw in env.get("FLASH_EXTRA_IMAGES", []):
        try:
            offset = _parse_int_auto(env.subst(str(offset_raw)))
        except ValueError:
            _warn(f"offset invalido em FLASH_EXTRA_IMAGES: {offset_raw!r} (ignorado)")
            continue

        path = Path(env.subst(str(path_raw)))
        if not path.is_file():
            _warn(f"imagem extra '{path}' (offset {hex(offset)}) nao encontrada; sera ignorada")
            continue

        images[offset] = path
        if path.name == "bootloader.bin":
            bootloader_path = path
        elif path.name == "partitions.bin":
            partitions_path = path

    # Garante bootloader.bin/partitions.bin mesmo se FLASH_EXTRA_IMAGES
    # nao tiver sido populada (fallback pelos nomes e offsets padrao).
    if bootloader_path is None:
        bootloader_path = build_dir / "bootloader.bin"
        if bootloader_path.is_file():
            images[DEFAULT_OFFSETS["bootloader.bin"]] = bootloader_path

    if partitions_path is None:
        partitions_path = build_dir / "partitions.bin"
        if partitions_path.is_file():
            images[DEFAULT_OFFSETS["partitions.bin"]] = partitions_path

    # Firmware (aplicativo principal). O nome normalmente e "firmware.bin"
    # (variavel PROGNAME do PlatformIO), e o offset e o da particao
    # "ota_0" real do projeto (ESP32_APP_OFFSET), com fallback p/ 0x10000.
    firmware_path = build_dir / ((env.subst("$PROGNAME") or "firmware") + ".bin")
    if not firmware_path.is_file():
        firmware_path = build_dir / "firmware.bin"

    images[_parse_app_offset(env)] = firmware_path

    return images, bootloader_path, partitions_path, firmware_path


def _check_required_files(env, bootloader_path, partitions_path, firmware_path):
    """Valida que os 3 arquivos obrigatorios existem. Caso falte algum,
    emite um erro claro e interrompe o build (nao gera merged.bin)."""
    required = {
        "bootloader.bin": bootloader_path,
        "partitions.bin": partitions_path,
        "firmware.bin": firmware_path,
    }
    missing = [f"{label} (esperado em '{path}')" for label, path in required.items() if not path.is_file()]
    if missing:
        _fail(
            env,
            "arquivo(s) obrigatorio(s) nao encontrado(s):\n  - "
            + "\n  - ".join(missing)
            + "\nCompile o projeto (pio run) antes de gerar o merged.bin.",
        )
        return False
    return True


def _validate_layout(env, images, flash_size):
    """Garante que nenhuma imagem se sobrepoe a outra e que tudo cabe
    dentro do tamanho de flash configurado para a placa."""
    ordered = sorted(images.items())
    previous_end, previous_path = 0, None
    for offset, path in ordered:
        size = path.stat().st_size
        end = offset + size
        if previous_path is not None and offset < previous_end:
            _fail(
                env,
                f"sobreposicao de imagens de flash: '{previous_path.name}' "
                f"termina em 0x{previous_end:X}, mas '{path.name}' comeca em 0x{offset:X}.",
            )
            return False
        if end > flash_size:
            _fail(
                env,
                f"'{path.name}' (offset 0x{offset:X} + {size} bytes = 0x{end:X}) "
                f"excede o tamanho de flash da placa (0x{flash_size:X}).",
            )
            return False
        previous_end, previous_path = end, path
    return True


def _sanity_check_magic(bootloader_path, partitions_path, firmware_path):
    """
    Checagem leve de compatibilidade com o formato esperado pelo SimulIDE:
    bootloader e firmware devem comecar com o byte magico 0xE9 (cabecalho
    de imagem ESP) e a tabela de particoes deve comecar com a assinatura
    0xAA50 - exatamente o que foi observado no merged.bin de referencia
    (Devkitc_test) nos offsets 0x1000/0x8000/0x10000. So emite aviso, pois
    e apenas uma checagem de sanidade extra, nao um requisito obrigatorio.
    """
    checks = (
        (bootloader_path, b"\xE9", "cabecalho de imagem ESP (0xE9)"),
        (partitions_path, b"\xAA\x50", "assinatura de tabela de particoes (0xAA50)"),
        (firmware_path, b"\xE9", "cabecalho de imagem ESP (0xE9)"),
    )
    for path, magic, description in checks:
        with open(path, "rb") as fh:
            header = fh.read(len(magic))
        if header != magic:
            _warn(f"'{path.name}' nao comeca com {description}; verifique se o arquivo esta correto.")


def _build_merged_bin(images, flash_size, output_path):
    """Cria o merged.bin: um buffer do tamanho da flash preenchido com
    0xFF (estado de flash apagada) com cada imagem escrita em seu offset,
    igual ao layout usado pelo SimulIDE/esptool."""
    buffer = bytearray(b"\xFF" * flash_size)
    for offset, path in sorted(images.items()):
        data = path.read_bytes()
        buffer[offset:offset + len(data)] = data
        _log(f"  0x{offset:06X}  ->  {path.name}  ({len(data)} bytes)")
    output_path.write_bytes(buffer)


def _copy_simulide_efuse(output_path):
    """
    Copia o esp32.efuse do SimulIDE para junto do merged.bin, com o mesmo
    nome base e extensao ".efuse" (e assim que o SimulIDE localiza o
    arquivo de efuse de um projeto - veja o exemplo Devkitc_test, que tem
    "devkitc_test.ino.merged.bin" ao lado de
    "devkitc_test.ino.merged.efuse").

    Se o SimulIDE nao for encontrado, apenas avisa e segue em frente: o
    merged.bin continua valido para gravacao/uso fora do simulador.
    """
    simulide_dir = _resolve_simulide_dir()
    efuse_src = simulide_dir / EFUSE_RELATIVE_PATH

    if not efuse_src.is_file():
        _warn(
            f"arquivo de efuse do SimulIDE nao encontrado em '{efuse_src}'. "
            "Defina a variavel de ambiente SIMULIDE apontando para a instalacao "
            "do SimulIDE se quiser que o '.efuse' seja copiado automaticamente."
        )
        return

    efuse_dst = output_path.with_suffix(".efuse")
    shutil.copyfile(efuse_src, efuse_dst)
    _log(f"efuse copiado: '{efuse_src}' -> '{efuse_dst}'")


def _copy_to_project_simulide_folder(env, merged_bin_path, merged_efuse_path):
    """
    Copia o merged.bin (e o merged.efuse, se existir) para a pasta
    "simulIDE" na raiz do projeto, caso ela exista. Isso permite manter
    os arquivos prontos para uso junto dos projetos ".sim2" que ficam
    nessa pasta, sem precisar apontar para o caminho dentro de ".pio".
    """
    project_dir = Path(env.subst("$PROJECT_DIR"))
    simulide_folder = project_dir / "simulIDE"

    if not simulide_folder.is_dir():
        _log(f"pasta '{simulide_folder}' nao encontrada; copia para a pasta simulIDE do projeto ignorada.")
        return

    dst_bin = simulide_folder / merged_bin_path.name
    shutil.copyfile(merged_bin_path, dst_bin)
    _log(f"merged.bin copiado para a pasta simulIDE do projeto: '{dst_bin}'")

    if merged_efuse_path.is_file():
        dst_efuse = simulide_folder / merged_efuse_path.name
        shutil.copyfile(merged_efuse_path, dst_efuse)
        _log(f"merged.efuse copiado para a pasta simulIDE do projeto: '{dst_efuse}'")


def after_build(source, target, env):
    """Ponto de entrada: roda automaticamente depois que o PlatformIO
    termina de gerar o firmware.bin do ambiente ativo."""
    _log("-" * 70)
    _log("Gerando merged.bin compativel com o SimulIDE...")

    # Passo 1: descobrir o ambiente ativo e a pasta de build real.
    # Usar $BUILD_DIR (em vez de montar ".pio/build/<env>" na mao) garante
    # que funciona mesmo com um 'build_dir' customizado no platformio.ini.
    pioenv = env["PIOENV"]
    build_dir = Path(env.subst("$BUILD_DIR"))
    _log(f"Ambiente ativo (PIOENV): {pioenv}")
    _log(f"Pasta de build: {build_dir}")

    # Passo 2: descobrir quais imagens existem e em que offsets entram.
    images, bootloader_path, partitions_path, firmware_path = _collect_flash_images(env, build_dir)

    # Passo 3: validar que os arquivos obrigatorios realmente existem.
    if not _check_required_files(env, bootloader_path, partitions_path, firmware_path):
        return  # _check_required_files ja chamou env.Exit(1)

    # Passo 4: descobrir o tamanho de flash da placa (define o tamanho
    # final do merged.bin, igual ao exemplo do SimulIDE - 4MB por padrao).
    try:
        flash_size_label = env.BoardConfig().get("upload.flash_size", "4MB")
    except Exception:
        flash_size_label = "4MB"
    flash_size = _parse_flash_size(flash_size_label)
    _log(f"Tamanho de flash da placa: {flash_size} bytes ({flash_size_label})")

    # Passo 5: validar que as imagens nao se sobrepoem e cabem na flash.
    if not _validate_layout(env, images, flash_size):
        return  # _validate_layout ja chamou env.Exit(1)

    # Passo 6: checagem de sanidade comparando com a estrutura de
    # referencia do SimulIDE (apenas avisos, nao interrompe o build).
    _sanity_check_magic(bootloader_path, partitions_path, firmware_path)

    # Passo 7: gerar o merged.bin propriamente dito.
    output_path = build_dir / "merged.bin"
    _log("Montando imagem unica de flash:")
    _build_merged_bin(images, flash_size, output_path)
    _log(f"merged.bin gerado com sucesso: {output_path}")

    # Passo 8: copiar o esp32.efuse do SimulIDE para uso no simulador.
    _copy_simulide_efuse(output_path)

    # Passo 9: copiar merged.bin/merged.efuse para a pasta "simulIDE" do
    # projeto, se ela existir.
    _copy_to_project_simulide_folder(env, output_path, output_path.with_suffix(".efuse"))

    _log("-" * 70)


# Registra a acao para rodar depois que o PlatformIO gerar o
# "${PROGNAME}.bin" do ambiente ativo. AlwaysBuild forca esse alvo a ser
# tratado como "fora de data" em todo "pio run"/Build, mesmo quando nada
# mudou no codigo-fonte (build incremental) - sem isso, o SCons pula o
# alvo e o post-action (e portanto o merged.bin) nunca e regenerado.
env.AlwaysBuild(env.AddPostAction("$BUILD_DIR/${PROGNAME}.bin", after_build))
