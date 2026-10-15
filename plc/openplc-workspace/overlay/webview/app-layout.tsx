// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Moldura do OpenPLC Editor dentro da aba do VS Code.
 *
 * Adaptado de src/frontend/components/_templates/app-layout.tsx (OpenPLC Editor v4.2.8): mesmos
 * modais, Toaster e AcceleratorHandler, sem a barra de título/menu nativos (o VS Code já tem a
 * dele) e sem o bloqueio de tela abaixo de 1024 px (a aba pode estar dividida).
 */

import Toaster from '@root/frontend/components/_features/[app]/toast/toaster'
import { ConfirmInstallLibrariesModal } from '@root/frontend/components/_organisms/modals/confirm-install-libraries-modal'
import { DebuggerMessageModal } from '@root/frontend/components/_organisms/modals/debugger-message-modal'
import { ConfirmDeleteElementModal } from '@root/frontend/components/_organisms/modals/delete-confirmation-modal'
import { MissingLibrariesModal } from '@root/frontend/components/_organisms/modals/missing-libraries-modal'
import type { SaveChangesFileModalData } from '@root/frontend/components/_organisms/modals/save-changes-file-modal'
import { SaveChangesFileModal } from '@root/frontend/components/_organisms/modals/save-changes-file-modal'
import type { SaveChangeModalProps } from '@root/frontend/components/_organisms/modals/save-changes-modal'
import { SaveChangesModal } from '@root/frontend/components/_organisms/modals/save-changes-modal'
import { AcceleratorHandler } from '@root/frontend/components/_templates/accelerator-handler'
import { useOpenPLCStore } from '@root/frontend/store'
import type { RungLadderState } from '@root/frontend/store/slices/ladder'
import { useProject, useSystem, useTheme } from '@root/middleware/shared/providers'
import { ComponentPropsWithoutRef, ReactNode, useCallback, useEffect } from 'react'

type LasecAppLayoutProps = ComponentPropsWithoutRef<'main'>

export const LasecAppLayout = ({ children, ...rest }: LasecAppLayoutProps): ReactNode => {
  const system = useSystem()
  const projectPort = useProject()
  const themePort = useTheme()
  const modals = useOpenPLCStore(useCallback((s) => s.modals, []))
  const { setSystemConfigs, setRecent } = useOpenPLCStore(useCallback((s) => s.workspaceActions, []))

  useEffect(() => {
    setSystemConfigs({ shouldUseDarkMode: themePort.getCurrentTheme() === 'dark' })
  }, [themePort, setSystemConfigs])

  useEffect(() => {
    void (async () => {
      try {
        const sysInfo = await system.getSystemInfo()
        setSystemConfigs({ OS: sysInfo.OS, arch: sysInfo.architecture, isWindowMaximized: false })
      } catch (error) {
        console.error('Falha ao ler informações do sistema:', error)
      }
      try {
        setRecent(await projectPort.getRecentProjects())
      } catch {
        setRecent([])
      }
    })()
  }, [system, projectPort, setSystemConfigs, setRecent])

  return (
    <div className='h-full bg-neutral-50 text-gray-500 dark:bg-neutral-950 dark:text-gray-400'>
      <main className='absolute bottom-0 left-0 right-0 top-0 flex overflow-hidden' {...rest}>
        {children}
        <Toaster />
        {modals?.['save-changes-project']?.open === true && (
          <SaveChangesModal
            isOpen={modals['save-changes-project'].open}
            validationContext={
              (modals['save-changes-project'].data as SaveChangeModalProps)?.validationContext ?? 'close-project'
            }
            onAfterAction={
              (modals['save-changes-project'].data as SaveChangeModalProps & { onAfterAction?: () => void })
                ?.onAfterAction
            }
          />
        )}
        {modals?.['save-changes-file']?.open === true && (
          <SaveChangesFileModal
            isOpen={modals['save-changes-file'].open}
            data={modals['save-changes-file'].data as SaveChangesFileModalData}
          />
        )}
        {modals?.['confirm-delete-element']?.open === true && (
          <ConfirmDeleteElementModal
            isOpen={modals['confirm-delete-element'].open}
            rung={modals['confirm-delete-element'].data as RungLadderState}
          />
        )}
        {modals?.['debugger-message']?.open === true && <DebuggerMessageModal />}
        {modals?.['missing-libraries']?.open === true && <MissingLibrariesModal />}
        {modals?.['confirm-install-libraries']?.open === true && <ConfirmInstallLibrariesModal />}
        <AcceleratorHandler />
      </main>
    </div>
  )
}
