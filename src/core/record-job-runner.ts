import { resolve } from 'node:path';

import type { ClickStep, PlanStep, TimelinePlan } from '../domain/plan.js';
import { TimelinePlan as TimelinePlanSchema } from '../domain/plan.js';
import { trimVideo, videoDurationMs } from '../infra/ffmpeg.js';
import { logger as rootLogger } from '../infra/logger.js';
import type {
  IPageSession,
  ObservedElement,
  SessionArtifacts,
} from '../ports/page-session.js';
import type { IPlanner } from '../ports/planner.js';

/**
 * Orchestrates a single recording job end-to-end.
 *
 * Pipeline (this is the canonical path; see decisions §0001/§0006):
 *
 *   1. Page setup (NOT recorded)
 *      - session.start()              browser + recordVideo begin
 *      - session.goto(url)
 *      - session.waitForVisualStability()
 *
 *   2. Plan + pre-resolve (NOT recorded — happens BEFORE the recording window)
 *      - session.screenshot()         visual context for planner
 *      - session.observeAll()         text candidates for planner
 *      - planner.plan(...)            ONE LLM call → TimelinePlan
 *      - for each click step: session.resolveTarget()  cache selectors
 *
 *   3. Record window (RECORDED)
 *      - session.beginRecording()     mark t=0 of "useful video"
 *      - execute plan steps with cached selectors (no LLM in the loop)
 *      - watchdog enforces a hard cap at plan.targetDurationMs * 1.2
 *
 *   4. Stop + trim (NOT recorded)
 *      - session.stop()               raw .webm finalized
 *      - ffmpeg trim raw → recording.webm using session.recording window
 *
 * The runner owns the *job*, not the session. Sessions can be reused (with
 * different runners) in the future if we want batched jobs in one browser.
 */

export interface RunRequest {
  url: string;
  prompt: string;
  durationMs: number;
  /** Output directory for video + log artifacts. Created if missing. */
  outputDir: string;
}

export interface RunResult {
  /** Trimmed video (the deliverable). */
  videoPath: string;
  /** Raw video before trim. Useful for debugging / cursor synth later. */
  rawVideoPath: string;
  actionLogPath: string;
  plan: TimelinePlan;
  metrics: RunMetrics;
}

export interface RunMetrics {
  totalWallClockMs: number;
  setupMs: number;          // session.start through observeAll
  planMs: number;           // single planner call
  preResolveMs: number;     // sum of resolveTarget calls
  recordingMs: number;      // beginRecording to stop
  trimMs: number;           // ffmpeg
  rawVideoMs: number | null;
  trimmedVideoMs: number | null;
  /** Number of click steps that resolved successfully before recording. */
  resolvedClicks: number;
  /** Number of click steps that fell back to runtime resolution (slow path). */
  fallbackClicks: number;
  /** Stable-step deadline timeouts during recording. */
  stableTimeouts: number;
}

export class RecordJobRunner {
  private readonly logger = rootLogger.child({ component: 'RecordJobRunner' });

  constructor(
    private readonly session: IPageSession,
    private readonly planner: IPlanner,
  ) {}

  async run(req: RunRequest): Promise<RunResult> {
    const wallClockT0 = Date.now();

    // -------------------------------- 1. Setup + plan in PARALLEL
    // Optimization: take an early screenshot (right after domcontentloaded)
    // and kick off the planner LLM call. The visual-stability wait runs in
    // parallel — by the time both are done we're ready for pre-resolve.
    //
    // Trade-off: the early screenshot may miss content that loads after
    // domcontentloaded. For typical content sites (README, articles, video
    // pages with server-side rendering) the relevant elements are present
    // at domcontentloaded and this is a clean win. Sites with heavy late
    // hydration may need to be planned post-stability instead — revisit if
    // we see plan quality regress.
    //
    // We also skip the broad `observeAll()` — each Stagehand observe call
    // sends ~20K tokens of accessibility tree to the LLM, taking 5-10s.
    // The multimodal planner sees the page through the screenshot.
    const tSetup = Date.now();
    await this.session.start();
    await this.session.goto(req.url);

    // Take an early screenshot (post-domcontentloaded, pre-stability).
    const tScreenshot = Date.now();
    const screenshot = await this.session.screenshot().catch(() => null);
    const screenshotMs = Date.now() - tScreenshot;

    // Kick off planner and stability wait in parallel.
    const tPlanLlm = Date.now();
    const planTask = this.planner.plan(
      {
        url: req.url,
        prompt: req.prompt,
        durationMs: req.durationMs,
        viewport: this.viewportFromSession(),
        candidates: [],
      },
      screenshot,
    );
    const stabilityTask = this.session.waitForVisualStability({
      quietMs: 400,
      maxMs: 3000,
    });

    const [planRaw] = await Promise.all([planTask, stabilityTask]);
    const planMs = Date.now() - tPlanLlm;
    let plan = planRaw;

    const setupMs = Date.now() - tSetup;
    this.logger.info(
      { setupMs, screenshotMs, planMs },
      'setup + plan complete (parallel)',
    );

    // Pre-resolve click targets in parallel. Doing this BEFORE the duration
    // adjustment lets us replace each click's `durationMs` with a realistic
    // estimate (approach scroll + anticipation + click) computed from the
    // cached bbox. This pulls plan ↔ execution into agreement, so
    // `adjustPlanDuration` can then accurately balance the rest.
    const tResolve = Date.now();
    const resolved = await this.preResolveClicks(plan.steps);
    const preResolveMs = Date.now() - tResolve;

    plan = recomputeClickDurations(plan, resolved, this.viewportFromSession());

    // Adjust the plan to hit the target duration. The planner often
    // under-budgets; this guarantees the recording is close to what the
    // user asked for, regardless of LLM behavior.
    plan = adjustPlanDuration(plan, req.durationMs);

    // ------------------------------------------------------- 3. Record window
    await this.session.beginRecording();
    const tRecord = Date.now();
    const stableTimeouts = await this.executePlan(plan, resolved, req.durationMs);
    const recordingMs = Date.now() - tRecord;

    // ----------------------------------------------------------- 4. Stop+trim
    const artifacts = await this.session.stop();

    const tTrim = Date.now();
    let videoPath = artifacts.videoPath;
    if (artifacts.recording) {
      const out = resolve(req.outputDir, 'recording.webm');
      await trimVideo(
        artifacts.videoPath,
        out,
        artifacts.recording.startedAtMs,
        artifacts.recording.endedAtMs,
      );
      videoPath = out;
    }
    const trimMs = Date.now() - tTrim;

    const rawVideoMs = await videoDurationMs(artifacts.videoPath).catch(() => null);
    const trimmedVideoMs = await videoDurationMs(videoPath).catch(() => null);

    const fallbackClicks = countSteps(plan, 'click') - resolved.size;

    const metrics: RunMetrics = {
      totalWallClockMs: Date.now() - wallClockT0,
      setupMs,
      planMs,
      preResolveMs,
      recordingMs,
      trimMs,
      rawVideoMs,
      trimmedVideoMs,
      resolvedClicks: resolved.size,
      fallbackClicks,
      stableTimeouts,
    };

    return {
      videoPath,
      rawVideoPath: artifacts.videoPath,
      actionLogPath: artifacts.actionLogPath,
      plan,
      metrics,
    };
  }

  // ----------------------------------------------------------- internals

  private viewportFromSession(): { width: number; height: number } {
    // The session config currently isn't exposed via IPageSession; we read it
    // via a fallback to the global config. Acceptable for now — see "future
    // improvement" comment in IPageSession (no method for this yet).
    const viewport = (this.session as unknown as {
      cfg?: { viewport: { width: number; height: number } };
    }).cfg?.viewport;
    return viewport ?? { width: 1280, height: 720 };
  }

  /**
   * Resolve each click target into a selector via the session's observe
   * primitive. Targets that fail to resolve are skipped — the runner logs
   * the failure and the executor may retry at runtime (slow path).
   *
   * Runs all resolutions in parallel: one observe call per target. Total
   * latency is the slowest single observe, not their sum.
   */
  private async preResolveClicks(
    steps: readonly PlanStep[],
  ): Promise<Map<number, ObservedElement>> {
    const resolved = new Map<number, ObservedElement>();
    const tasks: Promise<void>[] = [];

    steps.forEach((step, index) => {
      if (step.type !== 'click') return;
      const click = step;
      tasks.push(
        (async () => {
          const t0 = Date.now();
          const r = await this.session.resolveTarget(click.target);
          const elapsed = Date.now() - t0;
          if (r) {
            resolved.set(index, r);
            this.logger.info(
              { stepIndex: index, target: click.target, elapsedMs: elapsed, selector: r.selector },
              'pre-resolved click',
            );
          } else {
            this.logger.warn(
              { stepIndex: index, target: click.target, elapsedMs: elapsed },
              'click target could not be pre-resolved',
            );
          }
        })(),
      );
    });

    await Promise.all(tasks);
    return resolved;
  }

  /**
   * Execute the plan. Returns the count of stable-step timeouts (for metrics).
   *
   * Wall-clock watchdog: if running steps would exceed `1.2 * targetDurationMs`,
   * skip the rest. This is the user-facing duration guarantee.
   */
  private async executePlan(
    plan: TimelinePlan,
    resolved: Map<number, ObservedElement>,
    targetMs: number,
  ): Promise<number> {
    const deadlineMs = targetMs * 1.2;
    const t0 = Date.now();
    let stableTimeouts = 0;

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i]!;
      const elapsedSoFar = Date.now() - t0;
      if (elapsedSoFar >= deadlineMs) {
        this.logger.warn(
          { stepIndex: i, elapsedMs: elapsedSoFar, deadlineMs, remainingSteps: plan.steps.length - i },
          'wall-clock watchdog triggered, skipping remaining steps',
        );
        break;
      }

      switch (step.type) {
        case 'click':
          await this.executeClick(i, step, resolved);
          break;
        case 'scroll':
          await this.session.scroll(step.deltaY, { durationMs: step.durationMs });
          break;
        case 'wait':
          await this.session.wait(step.durationMs);
          break;
        case 'stable': {
          const tBefore = Date.now();
          await this.session.waitForVisualStability({
            quietMs: step.quietMs,
            maxMs: step.maxMs,
          });
          if (Date.now() - tBefore >= step.maxMs - 50) {
            stableTimeouts += 1;
          }
          break;
        }
      }
    }

    return stableTimeouts;
  }

  private async executeClick(
    stepIndex: number,
    step: ClickStep,
    resolved: Map<number, ObservedElement>,
  ): Promise<void> {
    const cached = resolved.get(stepIndex);
    if (cached) {
      try {
        await this.session.clickSelector(cached.selector, { description: cached.description });
        return;
      } catch (err) {
        this.logger.warn(
          { stepIndex, target: step.target, err },
          'cached click failed; falling back to runtime resolution',
        );
      }
    }
    // Slow path: resolve on the spot. Costs ~1-3s of recording time, accepted
    // when pre-resolution failed or the cached selector went stale.
    const live = await this.session.resolveTarget(step.target);
    if (!live) {
      this.logger.error(
        { stepIndex, target: step.target },
        'click target unresolvable at runtime; skipping step',
      );
      return;
    }
    await this.session.clickSelector(live.selector, { description: live.description });
  }
}

function countSteps(plan: TimelinePlan, type: PlanStep['type']): number {
  return plan.steps.filter((s) => s.type === type).length;
}

/**
 * Heuristics for the executor's discovery click. MUST stay in sync with
 * `StagehandPageSession.clickSelector` — if either changes, the other
 * needs an update or plans will systematically over/undershoot.
 *
 * Distance bands (SHORT/LONG) match the executor exactly.
 */
const APPROACH_THRESHOLD_PX = 60;
const SHORT_BAND_PX = 1000;
const LONG_BAND_PX = 2500;

// Short band — 300 px/s, clamp [800, 2200]
const SHORT_SPEED = 300;
const SHORT_MIN_MS = 800;
const SHORT_MAX_MS = 2200;
// Medium band — 600 px/s, clamp [1200, 2800]
const MED_SPEED = 600;
const MED_MIN_MS = 1200;
const MED_MAX_MS = 2800;
// Long band fling — 1500 px/s, clamp [1000, 2200]
const FLING_SPEED = 1500;
const FLING_MIN_MS = 1000;
const FLING_MAX_MS = 2200;
// Long band approach (last 600px) — 300 px/s, clamp [1500, 2200]
const LONG_APPROACH_PX = 600;
const LONG_APPROACH_SPEED = 300;
const LONG_APPROACH_MIN_MS = 1500;
const LONG_APPROACH_MAX_MS = 2200;
// Long band micro-pause between fling and approach — average of [150, 250]
const LONG_PAUSE_MS_AVG = 200;

const ANTICIPATION_MS_AVG = 650; // 500-800 random; use mean for budget
const CLICK_DISPATCH_MS = 100;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Estimate how long a discovery-click will take given the resolved bbox.
 * Used to align plan-time budgets with execution-time reality.
 *
 * Mirrors the multi-stage approach choreography in `clickSelector`.
 */
function estimateClickDurationMs(
  bbox: { x: number; y: number; width: number; height: number },
  viewport: { width: number; height: number },
): number {
  const desiredYInViewport = viewport.height * 0.35;
  const deltaPx = Math.abs(bbox.y - desiredYInViewport);
  let approachMs = 0;

  if (deltaPx > APPROACH_THRESHOLD_PX) {
    if (deltaPx <= SHORT_BAND_PX) {
      approachMs = clamp((deltaPx / SHORT_SPEED) * 1000, SHORT_MIN_MS, SHORT_MAX_MS);
    } else if (deltaPx <= LONG_BAND_PX) {
      approachMs = clamp((deltaPx / MED_SPEED) * 1000, MED_MIN_MS, MED_MAX_MS);
    } else {
      const flingPx = deltaPx - LONG_APPROACH_PX;
      const flingMs = clamp((flingPx / FLING_SPEED) * 1000, FLING_MIN_MS, FLING_MAX_MS);
      const slowMs = clamp(
        (LONG_APPROACH_PX / LONG_APPROACH_SPEED) * 1000,
        LONG_APPROACH_MIN_MS,
        LONG_APPROACH_MAX_MS,
      );
      approachMs = flingMs + LONG_PAUSE_MS_AVG + slowMs;
    }
  }
  return Math.round(approachMs + ANTICIPATION_MS_AVG + CLICK_DISPATCH_MS);
}

/**
 * Replace each click step's `durationMs` with the realistic
 * approach+anticipate+click estimate based on the resolved bbox.
 *
 * Click steps without a resolved bbox keep the planner's value (the
 * fallback path will re-resolve at runtime).
 */
function recomputeClickDurations(
  plan: TimelinePlan,
  resolved: Map<number, ObservedElement>,
  viewport: { width: number; height: number },
): TimelinePlan {
  const adjustedSteps: PlanStep[] = plan.steps.map((step, index) => {
    if (step.type !== 'click') return step;
    const r = resolved.get(index);
    if (!r?.bbox) return step;
    return { ...step, durationMs: estimateClickDurationMs(r.bbox, viewport) };
  });
  return TimelinePlanSchema.parse({ ...plan, steps: adjustedSteps });
}

/**
 * Compute the "expected" duration of a plan in ms. For stable steps we
 * count `quietMs` (the typical resolution time) rather than `maxMs`
 * (the deadline) — most stability waits resolve at quietMs.
 */
function expectedPlanDurationMs(plan: TimelinePlan): number {
  return plan.steps.reduce((acc, s) => {
    switch (s.type) {
      case 'click':
      case 'scroll':
      case 'wait':
        return acc + s.durationMs;
      case 'stable':
        return acc + s.quietMs;
    }
  }, 0);
}

/**
 * If the planner under- or over-budgeted, adjust the plan to land within
 * ±5% of `targetMs`.
 *
 * Strategy:
 *   under  → extend the last scroll step's duration (preserves the
 *            visual sense of "slow scroll"), or append a final wait if
 *            there are no scroll steps.
 *   over   → proportionally compress all scroll durations.
 *
 * Click and stable durations are NOT adjusted — they are semantically
 * meaningful (click is a click; stable settles based on the page itself).
 */
function adjustPlanDuration(plan: TimelinePlan, targetMs: number): TimelinePlan {
  const TOLERANCE = 0.05;
  const expected = expectedPlanDurationMs(plan);
  const lo = targetMs * (1 - TOLERANCE);
  const hi = targetMs * (1 + TOLERANCE);
  if (expected >= lo && expected <= hi) return plan;

  const adjusted: PlanStep[] = plan.steps.map((s) => ({ ...s }));

  if (expected < lo) {
    const deficit = targetMs - expected;
    // Find last scroll, extend it. Else append a wait.
    const lastScrollIdx = (() => {
      for (let i = adjusted.length - 1; i >= 0; i--) {
        if (adjusted[i]!.type === 'scroll') return i;
      }
      return -1;
    })();
    if (lastScrollIdx >= 0) {
      const s = adjusted[lastScrollIdx]!;
      if (s.type === 'scroll') {
        adjusted[lastScrollIdx] = { ...s, durationMs: s.durationMs + deficit };
      }
    } else {
      adjusted.push({ type: 'wait', durationMs: deficit, why: 'pad to target duration' });
    }
  } else if (expected > hi) {
    // Compress scroll durations proportionally so the new sum hits target.
    const scrollSum = adjusted.reduce(
      (a, s) => (s.type === 'scroll' ? a + s.durationMs : a),
      0,
    );
    if (scrollSum > 0) {
      const nonScrollSum = expected - scrollSum;
      const newScrollBudget = Math.max(targetMs - nonScrollSum, 500);
      const ratio = newScrollBudget / scrollSum;
      for (let i = 0; i < adjusted.length; i++) {
        const s = adjusted[i]!;
        if (s.type === 'scroll') {
          adjusted[i] = { ...s, durationMs: Math.max(300, Math.round(s.durationMs * ratio)) };
        }
      }
    }
  }

  // Re-validate via Zod so we don't smuggle malformed plans downstream.
  return TimelinePlanSchema.parse({ ...plan, steps: adjusted });
}
