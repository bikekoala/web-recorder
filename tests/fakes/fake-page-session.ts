import type {
  ActionLog,
  ActionLogEntry,
  Bbox,
  PageDiagnostic,
  Viewport,
} from '../../src/domain/action-log.js';
import type {
  IPageSession,
  ObservedElement,
  ScrollEasing,
  SessionArtifacts,
} from '../../src/ports/page-session.js';

/**
 * In-memory IPageSession for unit-testing the Director.
 *
 * Records every method call to `events`. Animations are simulated as
 * `setTimeout`-driven promises with the requested duration, so tests can
 * assert "did the LLM call return BEFORE the animation finished?".
 *
 * Override behavior by setting fields like `quickFindInViewportResult`
 * before invoking the Director.
 */
export class FakePageSession implements IPageSession {
  events: Array<{ kind: string; payload: unknown; t: number }> = [];
  startedAt = Date.now();

  scrollYValue = 0;
  url = 'https://test.example/';
  viewport: Viewport = { width: 1280, height: 720 };
  screenshotBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG header

  /** If set, quickFindInViewport returns this instead of null. */
  quickFindInViewportResult: ObservedElement | null = null;
  /** If set, quickFindOnPage returns this instead of null. */
  quickFindOnPageResult: ObservedElement | null = null;
  /** If set, resolveTarget returns this. */
  resolveTargetResult: ObservedElement | null = null;
  /** If set, observe(...) returns this. */
  observeResults: ObservedElement[] = [];

  /**
   * Queue of {@link PageDiagnostic} responses. Each call to
   * {@link pageDiagnostic} shifts one off; if the queue is empty a
   * conservative "clean" snapshot is returned. Tests can simulate a
   * "first probe shows blocker, second probe clean" sequence by
   * enqueueing two snapshots in order.
   */
  pageDiagnosticResults: PageDiagnostic[] = [];
  /**
   * If set to a function, it overrides the queue entirely — used by tests
   * that need to compute the snapshot dynamically based on session state
   * (e.g. "after N clicks, no more blockers"). Falls back to the queue.
   */
  pageDiagnosticImpl: (() => PageDiagnostic) | null = null;

  private record(kind: string, payload: unknown) {
    this.events.push({ kind, payload, t: Date.now() - this.startedAt });
  }

  async start(): Promise<void> { this.record('start', null); }
  async stop(): Promise<SessionArtifacts> {
    this.record('stop', null);
    return {
      videoPath: '/tmp/fake.webm',
      actionLogPath: '/tmp/fake.json',
      actionLog: {
        version: 1,
        startedAt: new Date(this.startedAt).toISOString(),
        durationMs: Date.now() - this.startedAt,
        recording: null,
        entries: [],
      } as ActionLog,
      viewport: this.viewport,
      recording: null,
    };
  }
  async goto(url: string): Promise<void> { this.url = url; this.record('goto', url); }
  async act(instruction: string): Promise<void> { this.record('act', instruction); }
  async observe(): Promise<ObservedElement[]> { return this.observeResults; }
  async scroll(deltaY: number, opts?: { durationMs?: number; easing?: ScrollEasing }) {
    const d = opts?.durationMs ?? 1000;
    this.record('scroll', { deltaY, durationMs: d, easing: opts?.easing });
    this.scrollYValue = Math.max(0, this.scrollYValue + deltaY);
    await new Promise((r) => setTimeout(r, d));
  }
  async wait(ms: number): Promise<void> {
    this.record('wait', ms);
    await new Promise((r) => setTimeout(r, ms));
  }
  async type(text: string, _opts?: { preMs?: number; keystrokeMs?: number }): Promise<void> {
    this.record('type', text);
    // Simulate human-paced typing duration so streaming-overlap tests still
    // see a meaningful elapsed window for the action.
    await new Promise((r) => setTimeout(r, Math.max(50, text.length * 50)));
  }
  async pressKey(key: string): Promise<void> {
    this.record('key', key);
    await new Promise((r) => setTimeout(r, 40));
  }
  async goBack(): Promise<void> {
    this.record('back', null);
    await new Promise((r) => setTimeout(r, 50));
  }
  async waitForVisualStability(opts?: { quietMs?: number; maxMs?: number }) {
    this.record('stable', opts);
  }
  async currentUrl(): Promise<string> { return this.url; }

  /** Test-controllable evidence-probe state — set in tests as needed. */
  pageTitleValue = '';
  focusedValueResult: string | null = null;
  /**
   * History stack depth. Default 1 = only the initial page exists; back()
   * would land on about:blank. Tests targeting back() recovery should set
   * this to ≥ 2 for happy paths.
   */
  historyDepthValue = 1;

  async scrollY(): Promise<number> { return this.scrollYValue; }
  async pageTitle(): Promise<string> { return this.pageTitleValue; }
  async focusedValue(): Promise<string | null> { return this.focusedValueResult; }
  async historyDepth(): Promise<number> { return this.historyDepthValue; }
  async screenshot(): Promise<Buffer> { return this.screenshotBytes; }
  async observeAll(): Promise<ObservedElement[]> { return this.observeResults; }
  async resolveTarget(): Promise<ObservedElement | null> { return this.resolveTargetResult; }
  /**
   * Optional test hook — if set, called by `clickSelector` AFTER recording the
   * event. Use it to simulate the click's effect (e.g. mutate `this.url` /
   * `this.observeResults` / `this.pageDiagnosticImpl` to model a navigation),
   * or to throw (e.g. `() => { throw new ElementNotFoundError('gone'); }`) to
   * model a click that failed.
   */
  clickSelectorImpl: ((selector: string, opts?: { description?: string }) => Promise<void> | void) | null = null;
  async clickSelector(selector: string, opts?: { description?: string }) {
    this.record('click', { selector, description: opts?.description });
    if (this.clickSelectorImpl) {
      await this.clickSelectorImpl(selector, opts);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  /**
   * Optional test hook — if set, called by `clickByDescription` after
   * recording the event. Use this to simulate failures, e.g.
   * `session.clickByDescriptionImpl = () => { throw new ElementNotFoundError(...); }`.
   */
  clickByDescriptionImpl: ((description: string) => Promise<void> | void) | null = null;
  async clickByDescription(description: string, opts?: { searchBudgetPx?: number }) {
    this.record('clickByDescription', { description, searchBudgetPx: opts?.searchBudgetPx });
    if (this.clickByDescriptionImpl) {
      await this.clickByDescriptionImpl(description);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  async quickFindInViewport(): Promise<ObservedElement | null> {
    return this.quickFindInViewportResult;
  }
  async quickFindOnPage(): Promise<ObservedElement | null> {
    return this.quickFindOnPageResult;
  }
  async beginRecording(): Promise<void> { this.record('beginRecording', null); }

  /** Captured by Director / RecordJobRunner via appendEntry(). */
  appendedEntries: ActionLogEntry[] = [];

  nowMs(): number { return Date.now() - this.startedAt; }
  appendEntry(entry: ActionLogEntry): void {
    this.appendedEntries.push(entry);
    this.record('appendEntry', { type: entry.type });
  }

  async pageDiagnostic(): Promise<PageDiagnostic> {
    this.record('pageDiagnostic', null);
    if (this.pageDiagnosticImpl) {
      return this.pageDiagnosticImpl();
    }
    const next = this.pageDiagnosticResults.shift();
    if (next) return next;
    return {
      url: this.url,
      title: '',
      interactiveElementCount: 0,
      visibleHeadings: [],
      blockerSignals: [],
    };
  }
}
