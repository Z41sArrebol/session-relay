import React from 'react'

type IconProps = { size?: number; className?: string }

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true
})

export function IconPlus({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

export function IconPause({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M9 5v14M15 5v14" />
    </svg>
  )
}

export function IconPlay({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M7 4.8v14.4L19 12 7 4.8Z" />
    </svg>
  )
}

export function IconRefresh({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 5v6h-6" />
    </svg>
  )
}

export function IconSparkles({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3Z" />
      <path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z" />
      <path d="M5 15l.6 1.4L7 17l-1.4.6L5 19l-.6-1.4L3 17l1.4-.6L5 15Z" />
    </svg>
  )
}

export function IconPackage({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3Z" />
      <path d="M4 7.5l8 4.5 8-4.5M12 12v9" />
    </svg>
  )
}

export function IconSend({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M21 3L10 14" />
      <path d="M21 3l-6.5 18-4.5-7-7-4.5L21 3Z" />
    </svg>
  )
}

export function IconSettings({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.6V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.6 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </svg>
  )
}

export function IconLock({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <rect x="4.5" y="10" width="15" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  )
}

export function IconChevron({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M8 5l7 7-7 7" />
    </svg>
  )
}

export function IconCopy({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M15 9V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h4" />
    </svg>
  )
}

export function IconFolder({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
    </svg>
  )
}

export function IconX({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}

export function IconCheck({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M4 12.5l5 5L20 6.5" />
    </svg>
  )
}

export function IconAlert({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M12 3L2.5 20h19L12 3Z" />
      <path d="M12 9v5M12 17.2v.1" />
    </svg>
  )
}

export function IconFile({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M6 2.8h7l5 5V21H6V2.8Z" />
      <path d="M13 2.8V8h5" />
    </svg>
  )
}

export function IconGit({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="7" r="2" />
      <path d="M6 7v10M8 7h6a4 4 0 0 1 4 4v4" />
    </svg>
  )
}

export function IconTerminal({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3 3-3 3M13 15h4" />
    </svg>
  )
}

export function IconClock({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5l3.5 2" />
    </svg>
  )
}

export function IconArrowRight({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M4 12h15M13 6l6 6-6 6" />
    </svg>
  )
}

export function IconDot({ size = 8, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 8 8" className={className} aria-hidden>
      <circle cx="4" cy="4" r="3.2" fill="currentColor" />
    </svg>
  )
}
