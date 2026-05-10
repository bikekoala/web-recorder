import { z } from 'zod';

import { Bbox } from './action-log.js';

// =====================================================================
// Director-based pipeline types (post-Director redesign)
// See docs/superpowers/specs/2026-05-10-streaming-director-design.md
// =====================================================================

export const ClickHint = z.object({
  description: z.string().min(1),
  selector: z.string().min(1),
  bboxAtRest: Bbox,
});
export type ClickHint = z.infer<typeof ClickHint>;

export const DirectorBriefing = z.object({
  prompt: z.string().min(1),
  durationMs: z.number().int().positive(),
  hints: z.array(ClickHint),
  rationale: z.string(),
});
export type DirectorBriefing = z.infer<typeof DirectorBriefing>;
