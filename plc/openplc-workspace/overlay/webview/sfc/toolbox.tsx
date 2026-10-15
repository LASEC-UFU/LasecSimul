// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Barra de ferramentas SFC na barra de atividades do OpenPLC (como a do FBD e a do Ladder):
 * passo, passo inicial, transição e bloco de ação, arrastados para o diagrama.
 */

import { ActivityBarButton } from '@root/frontend/components/_atoms/buttons/activity-bar'
import { TooltipSidebarWrapperButton } from '@root/frontend/components/_molecules/workspace-activity-bar/tooltip-button'
import { cn } from '@root/frontend/utils/cn'
import type { ComponentPropsWithoutRef, DragEvent, ReactNode } from 'react'

import { SFC_DRAG_TYPE } from './context'

const ICON_BACKGROUND =
  'M7 2.33333H21C23.5773 2.33333 25.6667 4.42267 25.6667 6.99999V21C25.6667 23.5773 23.5773 25.6667 21 25.6667H7C4.42267 25.6667 2.33333 23.5773 2.33333 21V7C2.33333 4.42267 4.42267 2.33333 7 2.33333Z'

const Icon = ({ children, className }: { children: ReactNode; className?: string }) => (
  <svg className={cn('h-6 w-6', className)} viewBox='0 0 28 28' fill='none' xmlns='http://www.w3.org/2000/svg'>
    <path opacity='0.4' d={ICON_BACKGROUND} fill='#B4D0FE' />
    {children}
  </svg>
)

const STROKE = { stroke: '#B4D0FE', strokeWidth: 1.4 }

export const StepIcon = () => (
  <Icon>
    <line x1='14' y1='5' x2='14' y2='9' {...STROKE} />
    <rect x='8' y='9' width='12' height='10' rx='1' {...STROKE} />
    <line x1='14' y1='19' x2='14' y2='23' {...STROKE} />
  </Icon>
)

export const InitialStepIcon = () => (
  <Icon>
    <rect x='7.5' y='8' width='13' height='12' rx='1' {...STROKE} />
    <rect x='9.5' y='10' width='9' height='8' rx='0.6' {...STROKE} />
    <line x1='14' y1='20' x2='14' y2='24' {...STROKE} />
  </Icon>
)

export const TransitionIcon = () => (
  <Icon>
    <line x1='14' y1='5' x2='14' y2='23' {...STROKE} />
    <line x1='8.5' y1='14' x2='19.5' y2='14' stroke='#B4D0FE' strokeWidth='2.6' strokeLinecap='round' />
  </Icon>
)

export const ActionBlockIcon = () => (
  <Icon>
    <rect x='5' y='10' width='7' height='8' rx='0.8' {...STROKE} />
    <line x1='12' y1='14' x2='14' y2='14' {...STROKE} />
    <rect x='14' y='10' width='9' height='8' {...STROKE} />
    <line x1='17' y1='10' x2='17' y2='18' {...STROKE} />
  </Icon>
)

const Tool = ({ label, onDragStart, children }: ComponentPropsWithoutRef<'div'> & { label: string }) => (
  <ActivityBarButton aria-label={label}>
    <div draggable onDragStart={onDragStart}>
      {children}
    </div>
  </ActivityBarButton>
)

export const SFCToolbox = () => {
  const start = (tool: string) => (event: DragEvent<HTMLDivElement>) => {
    event.dataTransfer.setData(SFC_DRAG_TYPE, tool)
    event.dataTransfer.setData('text/plain', tool)
    event.dataTransfer.effectAllowed = 'move'
  }
  return (
    <>
      <TooltipSidebarWrapperButton tooltipContent='Step'>
        <Tool label='Step' onDragStart={start('step')}>
          <StepIcon />
        </Tool>
      </TooltipSidebarWrapperButton>
      <TooltipSidebarWrapperButton tooltipContent='Initial step'>
        <Tool label='Initial step' onDragStart={start('initial-step')}>
          <InitialStepIcon />
        </Tool>
      </TooltipSidebarWrapperButton>
      <TooltipSidebarWrapperButton tooltipContent='Transition'>
        <Tool label='Transition' onDragStart={start('transition')}>
          <TransitionIcon />
        </Tool>
      </TooltipSidebarWrapperButton>
      <TooltipSidebarWrapperButton tooltipContent='Action block'>
        <Tool label='Action block' onDragStart={start('action')}>
          <ActionBlockIcon />
        </Tool>
      </TooltipSidebarWrapperButton>
    </>
  )
}
