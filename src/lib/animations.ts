/**
 * Centralized Framer Motion animation presets.
 * Based on iOS/macOS spring physics and Figma prototype interactions.
 */

/** Fast, snappy spring — dropdowns, small panels */
export const SPRING_SNAPPY = { stiffness: 420, damping: 36 } as const

/** Medium spring — sheets, modals, cards */
export const SPRING_MEDIUM = { stiffness: 400, damping: 32 } as const

/** Soft spring — page transitions, large elements */
export const SPRING_SOFT = { stiffness: 380, damping: 30 } as const

/** Gentle spring — chat messages, staggered lists */
export const SPRING_GENTLE = { stiffness: 500, damping: 28 } as const

/** Bottom sheet spring — iOS-style bounce */
export const SPRING_SHEET = { stiffness: 420, damping: 40 } as const

/** Fade-in transition durations (seconds) */
export const FADE_FAST = 0.12
export const FADE_NORMAL = 0.2
export const FADE_SLOW = 0.3

/** Slide transition durations (seconds) */
export const SLIDE_FAST = 0.15
export const SLIDE_NORMAL = 0.25

/** Stagger delay between list items (seconds) */
export const STAGGER_DELAY = 0.03

/** Shared initial/animate/exit patterns */
export const fadeIn = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
} as const

export const fadeInUp = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 8 },
} as const

export const fadeInDown = {
  initial: { opacity: 0, y: -8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
} as const

export const scaleIn = {
  initial: { opacity: 0, scale: 0.95 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.95 },
} as const

export const slideInRight = {
  initial: { opacity: 0, x: 20 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: 20 },
} as const

export const slideInLeft = {
  initial: { opacity: 0, x: -20 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -20 },
} as const

/** Bottom sheet — iOS-style slide up from bottom */
export const bottomSheet = {
  initial: { y: '100%' },
  animate: { y: 0 },
  exit: { y: '100%' },
} as const

/** Modal overlay fade */
export const overlayFade = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
} as const

/** Scale + fade for popovers / tooltips */
export const popoverIn = {
  initial: { opacity: 0, scale: 0.95, y: -4 },
  animate: { opacity: 1, scale: 1, y: 0 },
  exit: { opacity: 0, scale: 0.95, y: -4 },
} as const
