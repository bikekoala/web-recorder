import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ActionLogEntry, RecordingWindow } from '../../../src/domain/action-log.js';
import type { Performance } from '../../../src/domain/performance.js';
import { RunRecordSchema } from '../../../src/domain/run-record.js';
import { computeIntentSatisfaction, RecordJobRunner, videoRelativeTrimWindow } from '../../../src/core/record-job-runner.js';
import type { DirectorReport, IDirector } from '../../../src/ports/director.js';
import type { IPageSession } from '../../../src/ports/page-session.js';
import { FakePageSession } from '../../fakes/fake-page-session.js';
import { FakeReconnoiterer } from '../../fakes/fake-reconnoiterer.js';
import { FakeUrlResolver } from '../../fakes/fake-url-resolver.js';

const VIEWPORT = { width: 1280, height: 720 };
const WINDOW: RecordingWindow = { startedAtMs: 1000, endedAtMs: 11000 };

const click = (t: number, description?: string): ActionLogEntry => ({
  t,
  type: 'click',
  selector: 'xpath=//foo',
  ...(description ? { description } : {}),
  scrollY: 0,
  viewport: VIEWPORT,
});

const scroll = (t: number): ActionLogEntry => ({
  t,
  type: 'scroll',
  deltaY: 300,
  fromScrollY: 0,
  toScrollY: 300,
  durationMs: 800,
  viewport: VIEWPORT,
});

describe('computeIntentSatisfaction — UNIQUE-target matching', () => {
  it('returns "complete" when each target is clicked at least once AND a scroll happened', () => {
    const r = computeIntentSatisfaction(
      ['the simplified Chinese link'],
      [click(5000, 'click the 简体中文 link'), scroll(7000)],
      WINDOW,
    );
    expect(r.level).toBe('complete');
    expect(r.clicksExecuted).toBe(1);
    expect(r.scrollsExecuted).toBe(1);
  });

  it('counts UNIQUE targets, not total clicks (catches the YouTube 8x click bug)', () => {
    // Same target clicked 8 times — should be "partial" not "complete".
    // This is the regression test for the YouTube case where the agent
    // clicked the search bar 8 times without ever typing.
    const sameHint = 'click the search bar';
    const clicks = [
      click(5000, sameHint),
      click(5500, sameHint),
      click(6000, sameHint),
      click(6500, sameHint),
      click(7000, sameHint),
      click(7500, sameHint),
      click(8000, sameHint),
      click(8500, sameHint),
    ];
    // Two targets — but only one of them is matched by the click description.
    const r = computeIntentSatisfaction(
      ['the search bar', 'the MrBeast channel link'],
      [...clicks, scroll(9000)],
      WINDOW,
    );
    expect(r.level).toBe('partial');
    expect(r.clicksExecuted).toBe(8);
    expect(r.note).toMatch(/1\/2/);
  });

  it('lenient substring match: "build folder" matches "the build directory folder link"', () => {
    const r = computeIntentSatisfaction(
      ['the build directory folder link'],
      [click(5000, 'click the build folder'), scroll(7000)],
      WINDOW,
    );
    expect(r.level).toBe('complete');
  });

  it('CJK content tokens count as match material', () => {
    const r = computeIntentSatisfaction(
      ['the 简体中文 link'],
      [click(5000, 'click 简体中文链接'), scroll(7000)],
      WINDOW,
    );
    expect(r.level).toBe('complete');
  });

  it('returns "partial" when some targets are clicked but not all', () => {
    const r = computeIntentSatisfaction(
      ['the build folder', 'the package.json file', 'the simplified Chinese link'],
      [click(5000, 'click the build folder'), scroll(6000)],
      WINDOW,
    );
    expect(r.level).toBe('partial');
    expect(r.note).toMatch(/1\/3/);
  });

  it('returns "unmet" when zero targets are matched', () => {
    const r = computeIntentSatisfaction(['the search bar'], [scroll(5000)], WINDOW);
    expect(r.level).toBe('unmet');
  });

  it('returns "unknown" for performances with no click steps and some action', () => {
    const r = computeIntentSatisfaction([], [scroll(5000), scroll(7000)], WINDOW);
    expect(r.level).toBe('unknown');
  });

  it('excludes setup-phase clicks (before recording window)', () => {
    const setup = click(500, 'click the cookie accept button');
    const recording = click(5000, 'click the simplified Chinese link');
    const r = computeIntentSatisfaction(
      ['the simplified Chinese link'],
      [setup, recording, scroll(7000)],
      WINDOW,
    );
    expect(r.level).toBe('complete');
    expect(r.clicksExecuted).toBe(1); // setup click excluded from window
  });

  // §0033 — over-count regression. Models the exact github-multistep case
  // surfaced by the §0030 video judge: 3 targets, only 2 clicks (both on the
  // same Chinese-language element), and the old many-to-many matching
  // credited the lone "link" token toward all 3 targets. With 1-to-1
  // bipartite assignment, only the genuinely-clicked target matches.
  it('(§0033) one click cannot satisfy multiple unrelated targets via a single shared UI noun', () => {
    const r = computeIntentSatisfaction(
      [
        'the simplified 简体中文 link',
        'the build directory link',
        'the package.json file link',
      ],
      [
        click(5000, 'the simplified Chinese language switcher link in the GitHub footer'),
        click(8000, 'the Chinese language option'),
        scroll(9000),
      ],
      WINDOW,
    );
    // Both clicks land on the Chinese target — only 1/3 targets should count.
    // (Pre-§0033 this was reported "complete (all 3)" because every other
    //  target shared the lone "link" token with the click descriptions.)
    expect(r.level).toBe('partial');
    expect(r.note).toMatch(/1\/3/);
  });
});

describe('computeIntentSatisfaction — unresolved (dropped) targets are transparent, never silently `unknown`', () => {
  it('every requested click dropped (no planned hints) → `unmet`, names what it couldn\'t locate', () => {
    const r = computeIntentSatisfaction([], [scroll(5000)], WINDOW, ['the Felidae link (page tree too large to analyze in full)']);
    expect(r.level).toBe('unmet');
    expect(r.level).not.toBe('unknown');
    expect(r.note).toMatch(/couldn't locate/i);
    expect(r.note).toContain('the Felidae link');
  });

  it('some clicks planned/executed, others dropped → never `complete`; demoted to `partial` with the names', () => {
    const r = computeIntentSatisfaction(
      ['the simplified Chinese link'],
      [click(5000, 'click the 简体中文 link'), scroll(7000)],
      WINDOW,
      ['the Felidae taxobox link'],
    );
    // Without the dropped target this would be "complete"; the drop demotes it.
    expect(r.level).toBe('partial');
    expect(r.note).toContain('the Felidae taxobox link');
    expect(r.note).toMatch(/couldn't be located/i);
  });

  it('empty unresolvedTargets ⇒ exactly the prior behavior (still `unknown` when there were genuinely no click targets)', () => {
    expect(computeIntentSatisfaction([], [scroll(5000), scroll(7000)], WINDOW, []).level).toBe('unknown');
    expect(computeIntentSatisfaction([], [scroll(5000), scroll(7000)], WINDOW).level).toBe('unknown');
    // and the param is optional — old call sites keep working
    expect(computeIntentSatisfaction(['the X link'], [click(5000, 'click the X link'), scroll(6000)], WINDOW).level).toBe('complete');
  });
});

describe('videoRelativeTrimWindow — recordVideo clock-drift correction', () => {
  it('scales the window down by the raw-video-to-wall ratio when drift is present', () => {
    // The §0036 finding's numbers: 11 s wall-clock window inside a session
    // whose 41 s of wall time produced only ~38.76 s of video (f ≈ 0.9454).
    const out = videoRelativeTrimWindow({ startedAtMs: 29984, endedAtMs: 40902 }, 38760, 41000);
    expect(out.startMs).toBe(Math.round(29984 * (38760 / 41000)));
    expect(out.endMs).toBe(Math.round(40902 * (38760 / 41000)));
    // The kept clip is now ~10.3 s, not the ~8.78 s a wall-clock trim left.
    expect(out.endMs - out.startMs).toBeGreaterThan(10000);
    // endMs stays inside the raw video (no EOF clamp needed).
    expect(out.endMs).toBeLessThanOrEqual(38760);
  });

  it('leaves the window untouched when the raw-video length is unknown', () => {
    expect(videoRelativeTrimWindow({ startedAtMs: 1000, endedAtMs: 11000 }, null, 41000))
      .toEqual({ startMs: 1000, endMs: 11000 });
  });

  it('leaves the window untouched when the raw video is not shorter than wall time (f ≥ 1)', () => {
    expect(videoRelativeTrimWindow({ startedAtMs: 1000, endedAtMs: 11000 }, 41000, 41000))
      .toEqual({ startMs: 1000, endMs: 11000 });
    expect(videoRelativeTrimWindow({ startedAtMs: 1000, endedAtMs: 11000 }, 42000, 41000))
      .toEqual({ startMs: 1000, endMs: 11000 });
  });

  it('leaves the window untouched on a pathological ratio (f < 0.5)', () => {
    expect(videoRelativeTrimWindow({ startedAtMs: 1000, endedAtMs: 11000 }, 10000, 41000))
      .toEqual({ startMs: 1000, endMs: 11000 });
  });

  it('leaves the window untouched when session wall time is zero', () => {
    expect(videoRelativeTrimWindow({ startedAtMs: 1000, endedAtMs: 11000 }, 38760, 0))
      .toEqual({ startMs: 1000, endMs: 11000 });
  });
});

// Minimal stub IDirector that records the Performance it was handed and
// returns a canned report. Does NOT touch the session (the runner's wiring
// is what's under test, not playback).
class StubDirector implements IDirector {
  performances: Performance[] = [];
  constructor(private readonly report: DirectorReport) {}
  async run(performance: Performance, _session: IPageSession): Promise<DirectorReport> {
    this.performances.push(performance);
    return this.report;
  }
}

const perf = (steps: Performance['steps']): Performance => ({
  prompt: 'click 简中, slow scroll',
  durationMs: 10_000,
  steps,
  totalEstimatedMs: 8_000,
  rationale: 'test performance',
});

const clickStep = (description: string): Performance['steps'][number] => ({
  kind: 'click',
  target: { selector: 'xpath=//x', bbox: { x: 1, y: 1, width: 10, height: 10 }, description },
  anticipationMs: 0,
  reasoning: `click ${description}`,
});

const scrollStep = (): Performance['steps'][number] => ({
  kind: 'scroll',
  deltaPx: 600,
  durationMs: 1200,
  easing: 'inOutQuad',
  dwellAfterMs: 0,
  reasoning: 'slow scroll',
});

describe('RecordJobRunner — prophet wiring', () => {
  it('runs recon → director → stop and surfaces the Performance + metrics', async () => {
    const session = new FakePageSession();
    const performance: Performance = {
      ...perf([clickStep('the 简体中文 link'), scrollStep(), { kind: 'done', reasoning: 'finished' }]),
      rehearsal: { walkedSteps: 4, divergences: 1, reconverges: 1, truncated: false, timedOut: false },
      blockerDismissal: { rounds: 1, dismissed: ['Accept all cookies'], stillBlocked: false },
    };
    const recon = new FakeReconnoiterer([performance]);
    const director = new StubDirector({ totalMs: 8123, stepsExecuted: 3, replanCount: 1, endReason: 'done' });

    const urlResolver = new FakeUrlResolver({ url: 'https://test.example/', reasoning: 'fixed test URL' });
    const runner = new RecordJobRunner(session, urlResolver, recon, director);
    const result = await runner.run({
      prompt: 'click 简中, slow scroll',
      durationMs: 10_000,
      outputDir: '/tmp/web-recorder-test-output',
    });

    // The URL resolver was called once with the prompt.
    expect(urlResolver.calls).toEqual(['click 简中, slow scroll']);
    expect(result.urlResolution).toEqual({ url: 'https://test.example/', reasoning: 'fixed test URL' });

    // The reconnoiterer was called once with the resolved URL.
    expect(recon.calls).toHaveLength(1);
    expect(recon.calls[0]!.url).toBe('https://test.example/');
    expect(recon.calls[0]!.prompt).toBe('click 简中, slow scroll');
    expect(recon.calls[0]!.durationMs).toBe(10_000);

    // The director got the recon's Performance verbatim.
    expect(director.performances).toHaveLength(1);
    expect(director.performances[0]).toBe(performance);

    // Result surfaces the Performance and director report.
    expect(result.performance).toBe(performance);
    expect(result.directorReport.endReason).toBe('done');
    expect(result.metrics.plannedSteps).toBe(3);
    expect(result.metrics.replanCount).toBe(1);
    expect(result.metrics.recordingMs).toBe(8123);
    // No clicks in the action log (StubDirector doesn't play back) → 1 click
    // target planned, 0 executed → unmet.
    expect(result.metrics.intentSatisfaction.hintsResolvedPreRecording).toBe(1);
    expect(result.metrics.intentSatisfaction.level).toBe('unmet');
    // Rehearsal trace surfaced verbatim.
    expect(result.metrics.rehearsal).toEqual({ walkedSteps: 4, divergences: 1, reconverges: 1, truncated: false, timedOut: false });
    // Blocker-dismissal report surfaced verbatim.
    expect(result.metrics.blockerDismissal).toEqual({ rounds: 1, dismissed: ['Accept all cookies'], stillBlocked: false });

    // Session lifecycle: started, navigated, stopped.
    const kinds = session.events.map((e) => e.kind);
    expect(kinds).toContain('start');
    expect(kinds).toContain('goto');
    expect(kinds).toContain('stop');
  });

  it('RunMetrics.planDurationFit mirrors Performance.planDurationFit verbatim (F1)', async () => {
    // Drive a run where the reconnoiterer returns a Performance whose
    // planDurationFit is a known fixture; assert RunMetrics carries it
    // verbatim. The runner's contract for F1 (ADR §0040).
    const session = new FakePageSession();
    const performance: Performance = {
      ...perf([{ kind: 'done', reasoning: 'noop' }]),
      planDurationFit: { estimatedMs: 8500, targetMs: 10000, ratio: 0.85, status: 'ok' },
    };
    const recon = new FakeReconnoiterer([performance]);
    const director = new StubDirector({ totalMs: 10, stepsExecuted: 1, replanCount: 0, endReason: 'done' });
    const runner = new RecordJobRunner(session, new FakeUrlResolver(), recon, director);
    const result = await runner.run({
      prompt: 'do nothing',
      durationMs: 10_000,
      outputDir: '/tmp/web-recorder-test-output',
    });
    expect(result.metrics.planDurationFit?.estimatedMs).toBe(8500);
    expect(result.metrics.planDurationFit?.targetMs).toBe(10000);
    expect(result.metrics.planDurationFit?.ratio).toBe(0.85);
    expect(result.metrics.planDurationFit?.status).toBe('ok');
  });

  it('runs end-to-end with a no-op Performance', async () => {
    const session = new FakePageSession();
    const recon = new FakeReconnoiterer([perf([{ kind: 'done', reasoning: 'noop' }])]);
    const director = new StubDirector({ totalMs: 10, stepsExecuted: 1, replanCount: 0, endReason: 'done' });
    const runner = new RecordJobRunner(session, new FakeUrlResolver(), recon, director);
    const result = await runner.run({
      prompt: 'do nothing',
      durationMs: 5_000,
      outputDir: '/tmp/web-recorder-test-output',
    });
    expect(result.metrics.plannedSteps).toBe(1);
    expect(result.directorReport.endReason).toBe('done');
    // No rehearsal walk on this Performance → metrics.rehearsal is null.
    expect(result.metrics.rehearsal).toBeNull();
    // No blocker dismisser → metrics.blockerDismissal is null.
    expect(result.metrics.blockerDismissal).toBeNull();
  });
});

describe('RecordJobRunner — writes run.json with a parseable RunRecord', () => {
  // Real tempdir so the writer's fs.writeFile actually lands the file; the
  // other runner tests use a hardcoded /tmp path that may or may not exist
  // and rely on the runner's best-effort try/catch to swallow the ENOENT.
  // Here we want the actual on-disk artifact.
  let dir: string;
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'web-recorder-run-json-test-')); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it('writes run.json containing the full RunRecord (request + performance + metrics + directorReport + config + timings)', async () => {
    const session = new FakePageSession();
    const performance: Performance = {
      ...perf([clickStep('the sign-in link'), scrollStep(), { kind: 'done', reasoning: 'finished' }]),
      planDurationFit: { estimatedMs: 9500, targetMs: 10000, ratio: 0.95, status: 'ok' },
    };
    const recon = new FakeReconnoiterer([performance]);
    const director = new StubDirector({ totalMs: 9500, stepsExecuted: 3, replanCount: 0, endReason: 'done' });
    const urlResolver = new FakeUrlResolver({ url: 'https://example.com/page', reasoning: 'prompt named example.com' });
    const runner = new RecordJobRunner(session, urlResolver, recon, director);

    await runner.run({
      prompt: '点击 sign-in 然后慢慢滚动',
      durationMs: 10_000,
      outputDir: dir,
    });

    const raw = await readFile(join(dir, 'run.json'), 'utf8');
    const parsed = RunRecordSchema.parse(JSON.parse(raw));

    // schemaVersion is stamped.
    expect(parsed.schemaVersion).toBe(1);
    // Input is preserved verbatim, INCLUDING the original user prompt — this
    // is the whole reason `run.json` exists (see docs/output-layout.md).
    expect(parsed.request.prompt).toBe('点击 sign-in 然后慢慢滚动');
    expect(parsed.request.durationMs).toBe(10_000);
    expect(parsed.request.viewport).toEqual({ width: 1280, height: 720 });
    // URL resolution is captured alongside the request — the URL is now AI-resolved.
    expect(parsed.urlResolution.url).toBe('https://example.com/page');
    expect(parsed.urlResolution.reasoning).toBe('prompt named example.com');
    expect(parsed.urlResolution.model).toBe('fake/url-resolver');
    // Performance round-trips — A's rationale + per-step reasoning + the F1
    // planDurationFit transparency channel are all there to read.
    expect(parsed.performance.rationale).toBe(performance.rationale);
    expect(parsed.performance.steps).toHaveLength(3);
    expect(parsed.performance.planDurationFit).toEqual({
      estimatedMs: 9500, targetMs: 10000, ratio: 0.95, status: 'ok',
    });
    // Metrics + director report are present.
    expect(parsed.metrics.plannedSteps).toBe(3);
    expect(parsed.directorReport.endReason).toBe('done');
    // Config snapshot is non-empty and redacts the apiKey.
    expect(Object.keys(parsed.config).length).toBeGreaterThan(5);
    expect(parsed.config).not.toHaveProperty('openrouterApiKey');
    // Timings are valid ISO strings (Zod schema enforces datetime — parse
    // would have thrown if they weren't).
    expect(parsed.timings.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(parsed.timings.endedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('captures the resolver model id in run.json.urlResolution', async () => {
    const session = new FakePageSession();
    const recon = new FakeReconnoiterer([perf([{ kind: 'done', reasoning: 'noop' }])]);
    const director = new StubDirector({ totalMs: 10, stepsExecuted: 1, replanCount: 0, endReason: 'done' });
    const urlResolver = new FakeUrlResolver({ url: 'https://example.com/', reasoning: 'inline URL' });
    urlResolver.modelId = 'anthropic/claude-haiku-4.5';
    const runner = new RecordJobRunner(session, urlResolver, recon, director);

    const sub = await mkdtemp(join(tmpdir(), 'web-recorder-run-json-urlres-'));
    try {
      await runner.run({
        prompt: '去 https://example.com/ 看看',
        durationMs: 5_000,
        outputDir: sub,
      });
      const parsed = RunRecordSchema.parse(JSON.parse(await readFile(join(sub, 'run.json'), 'utf8')));
      expect(parsed.urlResolution.model).toBe('anthropic/claude-haiku-4.5');
      expect(parsed.urlResolution.url).toBe('https://example.com/');
    } finally {
      await rm(sub, { recursive: true, force: true });
    }
  });
});
