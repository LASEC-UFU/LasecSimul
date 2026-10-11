"""Gera extension/src/plc/iecStandardLibrary.ts a partir dos manifestos das bibliotecas que o
compilador do CLP usa (as mesmas de plcBuild.ts::IEC_LIBRARIES), do STruCpp fixado em
scripts/strucpp-pin.json. A tradução IL -> ST precisa dos tipos dos parâmetros e retornos para
tipar o resultado corrente; os editores LD/FBD usarão os mesmos dados.

Uso: python scripts/generate-iec-standard-library.py   (depois de npm run build:strucpp)
"""

import json
import os
import platform
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIBRARIES = ["iec-standard-fb.stlib", "iec-std-functions.stlib", "additional-function-blocks.stlib"]


def strucpp_libs_dir():
    pin = json.load(open(os.path.join(ROOT, "scripts", "strucpp-pin.json"), encoding="utf-8"))
    key = {"win32": "win32", "linux": "linux", "darwin": "darwin"}[sys.platform if sys.platform != "cygwin" else "win32"]
    arch = "arm64" if platform.machine().lower() in ("arm64", "aarch64") else "x64"
    return pin["version"], os.path.join(ROOT, "plc", "strucpp", "build", f"{key}-{arch}", "strucpp", "libs")


def params(entries):
    return [{"name": entry["name"].upper(), "type": entry["type"].upper()} for entry in entries or []]


def main():
    version, libs = strucpp_libs_dir()
    blocks = {}
    functions = {}
    for library in LIBRARIES:
        manifest = json.load(open(os.path.join(libs, library), encoding="utf-8"))["manifest"]
        for block in manifest.get("functionBlocks", []):
            blocks[block["name"].upper()] = {
                "library": manifest["name"],
                "inputs": params(block.get("inputs")),
                "outputs": params(block.get("outputs")),
                "inouts": params(block.get("inouts")),
            }
        for function in manifest.get("functions", []):
            entry = {
                "returnType": function["returnType"].upper(),
                "parameters": params(function.get("parameters")),
            }
            variadic = function.get("variadic")
            if variadic:
                entry["minArgs"] = int(variadic.get("minArgs", len(entry["parameters"])))
            functions[function["name"].upper()] = entry

    out = [
        "// GERADO por scripts/generate-iec-standard-library.py a partir do STruCpp " + version + " -- não editar.",
        "// Bibliotecas: " + ", ".join(name.replace(".stlib", "") for name in LIBRARIES) + ".",
        "",
        "export interface IecStdParameter {",
        "  name: string;",
        "  type: string;",
        "}",
        "",
        "export interface IecStdFunctionBlock {",
        "  library: string;",
        "  inputs: IecStdParameter[];",
        "  outputs: IecStdParameter[];",
        "  inouts: IecStdParameter[];",
        "}",
        "",
        "export interface IecStdFunction {",
        "  /** Tipo de retorno; ANY_* quando o retorno segue o tipo dos argumentos de mesmo genérico. */",
        "  returnType: string;",
        "  parameters: IecStdParameter[];",
        "  /** Presente nas funções extensíveis (ADD, AND, MAX, MUX...): mínimo de argumentos. */",
        "  minArgs?: number;",
        "}",
        "",
        f"export const IEC_STANDARD_LIBRARY_VERSION = \"{version}\";",
        "",
        "export const IEC_STANDARD_FUNCTION_BLOCKS: Readonly<Record<string, IecStdFunctionBlock>> = "
        + json.dumps(blocks, indent=2, ensure_ascii=False) + ";",
        "",
        "export const IEC_STANDARD_FUNCTIONS: Readonly<Record<string, IecStdFunction>> = "
        + json.dumps(functions, indent=2, ensure_ascii=False) + ";",
        "",
    ]
    target = os.path.join(ROOT, "extension", "src", "plc", "iecStandardLibrary.ts")
    with open(target, "w", encoding="utf-8", newline="\n") as handle:
        handle.write("\n".join(out))
    print(f"{target}: {len(blocks)} FBs, {len(functions)} funções (STruCpp {version})")


if __name__ == "__main__":
    main()
