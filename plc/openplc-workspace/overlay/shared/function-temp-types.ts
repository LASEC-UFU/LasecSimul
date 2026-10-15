// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Tipo da variável temporária que guarda a saída de uma função genérica (ADD, MUL, MAX, SEL... com
 * saída ANY_NUM, ANY_BIT...) num POU LD ou FBD.
 *
 * O transpilador do OpenPLC Editor 4.2.8 colapsa essas saídas para BOOL (emit/pou-graphical.ts: "A
 * future computeConnectionTypes port will narrow these properly"), então `CNT := ADD(CNT, 1)`
 * desenhado no LD vira `_TMP_ADD.._OUT : BOOL` e CNT só vale 0 ou 1. Aqui o tipo vem de quem recebe a
 * saída (`CNT := _TMP_.._OUT;`) ou, sem isso, de uma entrada genérica ligada a uma variável declarada
 * (`IN1 := CNT`). Sem nenhuma das duas pistas, fica o BOOL do OpenPLC.
 */

export interface FunctionTempContext {
  tempName: string
  /** Corpo ST já emitido pelo walker LD/FBD. */
  bodySt: string
  /** Variáveis do POU. */
  variables: ReadonlyArray<{ name: string; type?: { value?: string } }>
  /** Entradas formais da função no catálogo do OpenPLC. */
  formalInputs: ReadonlyArray<{ name: string; type: string }>
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Argumentos de uma chamada, separados pelas vírgulas de fora de parênteses. */
function splitArguments(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of text) {
    if (char === '(') depth += 1
    if (char === ')') depth -= 1
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
    } else current += char
  }
  if (current.trim()) parts.push(current)
  return parts.map((part) => part.trim())
}

export function narrowFunctionTempType(context: FunctionTempContext): string | undefined {
  const declared = new Map(context.variables.map((variable) => [variable.name.toUpperCase(), String(variable.type?.value ?? '').toUpperCase()]))
  const concrete = (name: string): string | undefined => {
    const type = declared.get(name.trim().toUpperCase())
    return type && !type.startsWith('ANY') ? type : undefined
  }
  const temp = escapeRegExp(context.tempName)
  for (const match of context.bodySt.matchAll(new RegExp(`([A-Za-z_][A-Za-z0-9_]*)\\s*:=\\s*${temp}\\s*;`, 'g'))) {
    const type = concrete(match[1])
    if (type) return type
  }
  const call = new RegExp(`${temp}\\s*:=\\s*[A-Za-z_][A-Za-z0-9_]*\\s*\\(([^;]*)\\)\\s*;`).exec(context.bodySt)
  if (!call) return undefined
  const formals = context.formalInputs.filter((formal) => formal.name.toUpperCase() !== 'EN')
  const generic = (name: string) => formals.find((formal) => formal.name.toUpperCase() === name.toUpperCase())?.type.startsWith('ANY') === true
  const args = splitArguments(call[1]).filter((arg) => !arg.includes('=>'))
  for (const [index, arg] of args.entries()) {
    const named = /^([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*(.+)$/.exec(arg)
    const formal = named ? named[1] : formals[index]?.name
    const value = (named ? named[2] : arg).trim()
    if (!formal || formal.toUpperCase() === 'EN' || !generic(formal) || !IDENTIFIER.test(value)) continue
    const type = concrete(value)
    if (type) return type
  }
  return undefined
}
