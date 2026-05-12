import OpenAI from 'openai';

import { config } from '../../infra/config.js';
import { logger as rootLogger } from '../../infra/logger.js';
import { blockerDismisserSystemPrompt, buildBlockerDismissUserText } from '../../prompts/index.js';
import type { IBlockerDismisser, BlockerDismissalReport } from '../../ports/blocker-dismisser.js';
import type { IPageSession, ObservedElement } from '../../ports/page-session.js';

/**
 * LlmBlockerDismisser — IBlockerDismisser backed by a small vision LLM.
 *
 * Off-camera, before recon plans and before the recording window opens, it
 * clears dismissable overlays (cookie/consent banners, X-to-close modals) so
 * they don't swallow every click. Probe → detect → click → re-probe loop,
 * capped by rounds and wall-clock; never throws — on any failure it returns
 * a report with `stillBlocked: true` and the caller proceeds. See Task #20 /
 * spec 2026-05-12.
 */

interface LlmBlockerDismisserOpts {
  client?: OpenAI;
  model?: string;
  maxRounds?: number;
  maxMs?: number;
}

interface DismissDecision {
  blocker: boolean;
  dismissTargetDescription?: string;
}

export class LlmBlockerDismisser implements IBlockerDismisser {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly maxRounds: number;
  private readonly maxMs: number;
  private readonly logger = rootLogger.child({ component: 'LlmBlockerDismisser' });

  constructor(opts: LlmBlockerDismisserOpts = {}) {
    this.client = opts.client ?? new OpenAI({ baseURL: config.openrouterBaseUrl, apiKey: config.openrouterApiKey });
    this.model = opts.model ?? config.llmBlockerModelResolved;
    this.maxRounds = opts.maxRounds ?? config.blockerDismissMaxRounds;
    this.maxMs = opts.maxMs ?? config.blockerDismissMaxMs;
  }

  async dismiss(session: IPageSession): Promise<BlockerDismissalReport> {
    const deadlineAt = Date.now() + this.maxMs;
    const dismissed: string[] = [];
    let rounds = 0;

    const blocked = async (): Promise<boolean> => {
      const diag = await session.pageDiagnostic().catch(() => null);
      return !!diag && diag.blockerSignals.length > 0;
    };

    if (!(await blocked())) {
      return { rounds: 0, dismissed: [], stillBlocked: false };
    }

    while (rounds < this.maxRounds && Date.now() < deadlineAt) {
      rounds++;
      const shot = await session.screenshot().catch(() => null);
      const observed = await session.observeAll().catch((): ObservedElement[] => []);

      let decision: DismissDecision | null;
      try {
        decision = await this.detect(shot, observed);
      } catch (err) {
        this.logger.warn({ err }, 'blocker detect call failed');
        return { rounds, dismissed, stillBlocked: true };
      }
      if (!decision) {
        this.logger.warn('blocker detect response unparseable');
        return { rounds, dismissed, stillBlocked: true };
      }
      if (!decision.blocker || !decision.dismissTargetDescription) {
        // Page is clear, or the model declined (paywall / login wall). Done.
        return { rounds, dismissed, stillBlocked: false };
      }

      const target = await session.resolveTarget(decision.dismissTargetDescription).catch(() => null);
      if (!target || !target.bbox) {
        this.logger.warn({ desc: decision.dismissTargetDescription }, 'blocker dismiss target did not resolve — stopping');
        return { rounds, dismissed, stillBlocked: true };
      }
      try {
        await this.clickTarget(target.selector, target.bbox, decision.dismissTargetDescription, session);
      } catch (err) {
        this.logger.warn({ err, desc: decision.dismissTargetDescription }, 'blocker dismiss click failed — stopping');
        return { rounds, dismissed, stillBlocked: true };
      }
      dismissed.push(decision.dismissTargetDescription);
      await session.waitForVisualStability().catch(() => {});

      if (!(await blocked())) {
        this.logger.info({ rounds, dismissed }, 'blockers dismissed');
        return { rounds, dismissed, stillBlocked: false };
      }
      // else: another overlay surfaced — loop.
    }
    this.logger.warn({ rounds, dismissed }, 'blocker dismiss capped with a blocker still present');
    return { rounds, dismissed, stillBlocked: true };
  }

  private async detect(
    screenshot: Buffer | null,
    observed: ObservedElement[],
  ): Promise<DismissDecision | null> {
    const userText = buildBlockerDismissUserText(observed.map((e) => ({ selector: e.selector, description: e.description })));
    const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [{ type: 'text', text: userText }];
    if (screenshot && screenshot.length > 0) {
      content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${screenshot.toString('base64')}` } });
    }
    const completion = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: blockerDismisserSystemPrompt },
        { role: 'user', content },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 300,
    });
    const raw = completion.choices[0]?.message?.content ?? '';
    return parseDismissDecision(raw);
  }

  /** Coord-click if the bbox is in the viewport (robust to stale deep XPaths); else clickSelector. */
  private async clickTarget(
    selector: string,
    bbox: { x: number; y: number; width: number; height: number },
    description: string,
    session: IPageSession,
  ): Promise<void> {
    const vp = session.viewport;
    const cx = bbox.x + bbox.width / 2;
    const cy = bbox.y + bbox.height / 2; // dismiss controls are virtually always at scrollY 0
    if (cx >= 0 && cx < vp.width && cy >= 0 && cy < vp.height) {
      try {
        await session.clickAt(cx, cy, { description });
        return;
      } catch {
        // fall through to the selector
      }
    }
    await session.clickSelector(selector, { description });
  }
}

function parseDismissDecision(raw: string): DismissDecision | null {
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const obj = tryParse(raw) ?? tryParse(stripped);
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.blocker !== 'boolean') return null;
  const desc = typeof o.dismissTargetDescription === 'string' && o.dismissTargetDescription.trim()
    ? o.dismissTargetDescription
    : undefined;
  return desc ? { blocker: o.blocker, dismissTargetDescription: desc } : { blocker: o.blocker };
}
