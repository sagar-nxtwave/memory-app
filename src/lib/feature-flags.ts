// Feature Flags — centralized toggle system for all new features.
// All flags are read from environment variables and default to enabled (true).
// Set to "false" in .env.local to disable any feature.
//
// Usage: import { features } from '@/lib/feature-flags'
//        if (features.followUpSuggestions) { ... }

export const features = {
  /** Smart follow-up suggestions after each answer */
  followUpSuggestions: process.env.NEXT_PUBLIC_FEATURE_FOLLOW_UP_SUGGESTIONS !== 'false',

  /** Auto-generate charts for aggregate answers (deals by community, pipeline, etc.) */
  autoCharts: process.env.NEXT_PUBLIC_FEATURE_AUTO_CHARTS !== 'false',

  /** Persist feedback (thumbs up/down) to DB for self-improvement learning */
  feedbackPersistence: process.env.NEXT_PUBLIC_FEATURE_FEEDBACK_PERSISTENCE !== 'false',

  /** MCP cross-check — verify MCP answers against independent SOQL query */
  mcpCrossCheck: process.env.NEXT_PUBLIC_FEATURE_MCP_CROSS_CHECK !== 'false',

  /** MCP verification — quickCheck + verifyAnswer on MCP answers before returning */
  mcpVerification: process.env.NEXT_PUBLIC_FEATURE_MCP_VERIFICATION !== 'false',

  /** Post-answer hallucination disclaimer — send warning when validator detects issues */
  hallucinationDisclaimer: process.env.NEXT_PUBLIC_FEATURE_HALLUCINATION_DISCLAIMER !== 'false',
} as const

export type FeatureFlags = typeof features
