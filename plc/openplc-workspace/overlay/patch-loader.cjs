// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Ajustes pontuais no código do OpenPLC Editor durante o empacotamento, sem tocar a árvore
 * original. Cada ajuste procura um trecho exato; se o trecho sumir ou aparecer mais de uma vez
 * (outra versão do OpenPLC), o build falha em vez de seguir sem o ajuste.
 */

const path = require('path')

const DISABLED = 'hover:bg-white dark:hover:bg-neutral-950 cursor-not-allowed pointer-events-none opacity-30'

const PATCHES = [
  {
    // Projeto PLC no LasecSimul: sem dispositivo/placa, servidores Modbus/OPC UA/S7, dispositivos
    // remotos, telas de fabricante, controle de versão e controles do runtime -- o CLP é o bloco
    // do esquemático. O depurador fica: ele lê e força o CLP da simulação (ports.ts).
    file: 'src/middleware/shared/ports/types.ts',
    find: `  return {
    hasPrograms: true,
    hasResource: true,
    hasDevices: true,
    hasServers: true,
    hasRemoteDevices: true,
    hasVendorScreens: true,
    hasProgramBuild: true,
    hasLibraryBuild: false,
    hasVersionControl: true,
    hasDebugger: true,
    hasRuntimeControls: true,
    hasLibraryManifest: false,
  }`,
    replace: `  return {
    hasPrograms: true,
    hasResource: true,
    hasDevices: false,
    hasServers: false,
    hasRemoteDevices: false,
    hasVendorScreens: false,
    hasProgramBuild: true,
    hasLibraryBuild: false,
    hasVersionControl: false,
    hasDebugger: true,
    hasRuntimeControls: false,
    hasLibraryManifest: false,
  }`,
  },
  {
    // POU novo: Python e C/C++ dependem do runtime do OpenPLC e não rodam no CLP do LasecSimul;
    // ficam desabilitados. O SFC, desabilitado no OpenPLC 4.2.8 (sem editor), passa a valer.
    file: 'src/frontend/components/_features/[workspace]/create-element/element-card/index.tsx',
    find: `  'Sequential Functional Chart':
    '${DISABLED}',`,
    replace: `  'Sequential Functional Chart': '',`,
  },
  {
    file: 'src/frontend/components/_features/[workspace]/create-element/element-card/index.tsx',
    find: `  Python: '',
  'C/C++': '',
} as const`,
    replace: `  Python: '${DISABLED}',
  'C/C++': '${DISABLED}',
} as const`,
  },
  {
    // Editor SFC do LasecSimul no lugar do stub do OpenPLC.
    file: 'src/frontend/components/_features/[workspace]/editor/graphical/SFC/index.tsx',
    find: `export default function SfcEditor() {
  return <div>heres the sfceditor </div>
}`,
    replace: `export { default } from '@root/lasecsimul/webview/sfc/sfc-editor'`,
  },
  {
    // Barra de ferramentas SFC na barra de atividades, como a do FBD e a do Ladder.
    file: 'src/frontend/components/_organisms/workspace-activity-bar/index.tsx',
    find: `import { LadderToolbox } from './ladder-toolbox'`,
    replace: `import { LadderToolbox } from './ladder-toolbox'
import { SFCToolbox } from '@root/lasecsimul/webview/sfc/toolbox'`,
  },
  {
    file: 'src/frontend/components/_organisms/workspace-activity-bar/index.tsx',
    find: `        {isLadderEditor && (
          <>
            <DividerActivityBar />
            <div className='flex w-full flex-col items-center gap-5'>
              <LadderToolbox />
            </div>
          </>
        )}`,
    replace: `        {isLadderEditor && (
          <>
            <DividerActivityBar />
            <div className='flex w-full flex-col items-center gap-5'>
              <LadderToolbox />
            </div>
          </>
        )}
        {editor?.type === 'plc-graphical' && editor?.meta.language === 'sfc' && (
          <>
            <DividerActivityBar />
            <div className='flex w-full flex-col items-center gap-5'>
              <SFCToolbox />
            </div>
          </>
        )}`,
  },
  {
    // Arquivo do POU SFC: `pous/<pasta>/<nome>.sfc`, no formato gráfico do OpenPLC (cabeçalho,
    // variáveis e corpo em JSON), lido e gravado pelos mesmos caminhos do LD e do FBD.
    file: 'src/frontend/utils/PLC/pou-file-extensions.ts',
    find: `  fbd: '.fbd',`,
    replace: `  fbd: '.fbd',
  sfc: '.sfc',`,
  },
  {
    file: 'src/frontend/utils/PLC/pou-text-serializer.ts',
    find: `  if (pou.body.language !== 'ld' && pou.body.language !== 'fbd') {
    throw new Error(\`serializeGraphicalPouToString only supports LD and FBD languages, got: \${pou.body.language}\`)`,
    replace: `  if (pou.body.language !== 'ld' && pou.body.language !== 'fbd' && pou.body.language !== 'sfc') {
    throw new Error(\`serializeGraphicalPouToString only supports LD, FBD and SFC languages, got: \${pou.body.language}\`)`,
  },
  {
    file: 'src/frontend/utils/PLC/pou-text-serializer.ts',
    find: `  } else if (language === 'ld' || language === 'fbd') {`,
    replace: `  } else if (language === 'ld' || language === 'fbd' || language === 'sfc') {`,
  },
  {
    file: 'src/backend/shared/utils/parse-project-files.ts',
    find: `  if (language === 'ld' || language === 'fbd') {
    const endRegex`,
    replace: `  if (language === 'ld' || language === 'fbd' || language === 'sfc') {
    const endRegex`,
  },
  {
    file: 'src/backend/shared/utils/parse-project-files.ts',
    find: `    } else if (language === 'ld' || language === 'fbd') {
      return parseGraphicalPouFromString`,
    replace: `    } else if (language === 'ld' || language === 'fbd' || language === 'sfc') {
      return parseGraphicalPouFromString`,
  },
  {
    // Saída de função genérica (ADD, MUL, SEL...) no LD/FBD: o OpenPLC 4.2.8 a declara BOOL; o tipo
    // passa a vir de quem a recebe ou de uma entrada ligada (shared/function-temp-types.ts).
    file: 'src/backend/shared/transpilers/st-transpiler/emit/pou-graphical.ts',
    find: `import { computeValue } from './value'
`,
    replace: `import { computeValue } from './value'
import { narrowFunctionTempType } from '@root/lasecsimul/shared/function-temp-types'
`,
  },
  {
    file: 'src/backend/shared/transpilers/st-transpiler/emit/pou-graphical.ts',
    find: `      if (outPort) {
        const collapsed = outPort.type.startsWith('ANY') ? 'BOOL' : outPort.type`,
    replace: `      if (outPort) {
        const narrowed = outPort.type.startsWith('ANY')
          ? narrowFunctionTempType({
              tempName: sv.name,
              bodySt: emitted.bodySt,
              variables: pou.interface?.variables ?? [],
              formalInputs: stdResolved.infos.inputs,
            })
          : undefined
        const collapsed = outPort.type.startsWith('ANY') ? (narrowed ?? 'BOOL') : outPort.type`,
  },
]

const root = process.cwd()
const byFile = new Map()
for (const patch of PATCHES) {
  const key = path.normalize(path.join(root, patch.file)).toLowerCase()
  byFile.set(key, [...(byFile.get(key) ?? []), patch])
}

module.exports = function lasecsimulPatchLoader(source) {
  const patches = byFile.get(path.normalize(this.resourcePath).toLowerCase())
  if (!patches) return source
  let text = source.replace(/\r\n/g, '\n')
  for (const patch of patches) {
    const count = text.split(patch.find).length - 1
    if (count !== 1) {
      this.emitError(new Error(`[lasecsimul] ajuste em ${patch.file}: trecho esperado encontrado ${count} vezes`))
      return source
    }
    text = text.replace(patch.find, () => patch.replace)
  }
  return text
}
