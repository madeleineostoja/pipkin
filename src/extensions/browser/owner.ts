import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright-core";
import {
  BROWSER_STATE_LOSS_NOTICE,
  BrowserError,
  browserError,
} from "./errors.js";
import { LIMITS } from "./limits.js";

export type DiagnosticCategory =
  | "console"
  | "page_error"
  | "request_failed"
  | "http_error";
export type Diagnostic = {
  sequence: number;
  category: DiagnosticCategory;
  message: string;
  url?: string;
  method?: string;
  status?: number;
  tabId: string;
};
export type Tab = { id: string; page: Page; lastActive: number };
type ChromiumFacade = Pick<typeof chromium, "launch">;

/** Owns one disposable Playwright session and its single serialized operation lane. */
export class BrowserOwner {
  private browser?: Browser;
  private context?: BrowserContext;
  private startingBrowser?: Browser;
  private active?: Tab;
  private readonly tabs = new Map<Page, Tab>();
  private diagnostics: Diagnostic[] = [];
  private queue: Promise<void> = Promise.resolve();
  private launch?: Promise<void>;
  private shutdownTask?: Promise<void>;
  private accepting = true;
  private generation = 0;
  private nextTab = 1;
  private nextActivation = 1;
  private sequence = 1;
  private refEpoch = 0;
  private refPage?: Page;
  private readonly snapshotRefs = new Map<string, string>();
  private disconnectGeneration = -1;
  private expectedDisconnect = false;
  private activeRecovery?: Promise<void>;
  private activeAbort?: () => Promise<void>;
  private aborting = false;
  private actionPages: Tab[] | undefined;
  private activeChange?: string;
  private dispatchedMutation?: boolean;
  private stateLost = false;
  private readonly sensitiveTexts = new Set<string>();

  constructor(private readonly browserType: ChromiumFacade = chromium) {}

  async reset(): Promise<void> {
    await this.shutdown();
    this.accepting = true;
    this.nextTab = 1;
    this.nextActivation = 1;
    this.sequence = 1;
    this.stateLost = false;
  }

  async run<T>(
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (signal?.aborted) {
      throw new BrowserError(
        "cancelled",
        "Browser call was cancelled before dispatch.",
      );
    }
    if (!this.accepting) {
      throw new BrowserError("cancelled", "Browser session is shutting down.");
    }
    let release!: () => void;
    const previous = this.queue;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The tail remains chained to its predecessor even when this caller gives
    // up while waiting. That keeps later work out of a live shared runtime.
    this.queue = previous.then(() => gate);
    try {
      await this.waitForTurn(previous, signal);
      if (signal?.aborted || !this.accepting) {
        throw new BrowserError(
          "cancelled",
          "Browser call was cancelled before dispatch.",
        );
      }
      return await this.execute(operation, signal);
    } finally {
      release();
    }
  }

  async page(): Promise<Page> {
    await this.ensure();
    if (!this.active || this.active.page.isClosed()) {
      await this.recoverActive();
    }
    if (!this.active) {
      throw new BrowserError(
        "page_gone",
        "No active browser page is available.",
      );
    }
    return this.active.page;
  }

  activeTab(): Tab | undefined {
    return this.active;
  }
  liveTabs(): Tab[] {
    return [...this.tabs.values()].filter((tab) => !tab.page.isClosed());
  }
  getDiagnostics(): readonly Diagnostic[] {
    return this.diagnostics;
  }
  contextState(): { generation: number; stateLost: boolean } {
    return { generation: this.generation, stateLost: this.stateLost };
  }
  consumeStateLossNotice(): string | undefined {
    if (!this.stateLost) {
      return undefined;
    }
    this.stateLost = false;
    return BROWSER_STATE_LOSS_NOTICE;
  }
  canRetryObservation(generation: number): boolean {
    return this.disconnectGeneration > generation;
  }
  registerSnapshot(page: Page, value: string): string {
    this.refEpoch += 1;
    this.refPage = page;
    this.snapshotRefs.clear();
    return value.replace(/\[ref=([^\]]+)\]/gu, (_match, raw: string) => {
      const ref = `${raw}@${this.refEpoch}`;
      this.snapshotRefs.set(ref, raw);
      return `[ref=${ref}]`;
    });
  }
  resolveSnapshotRef(page: Page, ref: string): string | undefined {
    return this.refPage === page ? this.snapshotRefs.get(ref) : undefined;
  }
  retainSnapshotRefs(value: string): void {
    for (const ref of this.snapshotRefs.keys()) {
      if (!value.includes(`[ref=${ref}]`)) {
        this.snapshotRefs.delete(ref);
      }
    }
  }
  invalidateRefs(page?: Page): void {
    if (!page || this.refPage === page) {
      this.refPage = undefined;
      this.snapshotRefs.clear();
    }
  }
  withContext(error: BrowserError, recovery?: string): BrowserError {
    const changes = [...new Set([recovery, this.activeChange].filter(Boolean))];
    if (!this.stateLost && changes.length === 0) {
      return error;
    }
    return new BrowserError(error.category, error.message, {
      ...error.details,
      ...(this.stateLost ? { stateLost: true } : {}),
      ...(changes.length > 0 ? { recovery: changes.join(" ") } : {}),
    });
  }
  consumeActiveChange(): string | undefined {
    const change = this.activeChange;
    this.activeChange = undefined;
    return change;
  }
  /** Keeps model-supplied text out of subsequent Browser-owned evidence. */
  rememberSensitiveText(value: string): void {
    if (value) {
      this.sensitiveTexts.add(value);
    }
  }
  redactText(value: string): string {
    let redacted = value;
    for (const sensitive of [...this.sensitiveTexts].sort(
      (left, right) => right.length - left.length,
    )) {
      redacted = redacted.replaceAll(sensitive, "[redacted]");
    }
    return redacted;
  }

  beginAction(): void {
    this.actionPages = [];
    this.activeChange = undefined;
  }
  /** Records the operation boundary before Playwright can affect page state. */
  markDispatched(mutation: boolean): void {
    this.dispatchedMutation = mutation;
  }
  async settleAction(): Promise<void> {
    const popup = this.actionPages
      ?.filter((tab) => !tab.page.isClosed())
      .at(-1);
    this.actionPages = undefined;
    if (popup) {
      this.activate(popup);
      this.activeChange = `Activated new tab ${popup.id}.`;
    }
    if (!this.active || this.active.page.isClosed()) {
      await this.recoverActive();
    }
  }

  async newTab(): Promise<Tab> {
    await this.ensure();
    if (!this.context) {
      throw new BrowserError("browser_disconnected", "Browser disconnected.");
    }
    if (this.liveTabs().length >= LIMITS.tabCount) {
      throw new BrowserError("target", "Browser has reached its 20-tab limit.");
    }
    const page = await this.context.newPage();
    const tab = this.own(page);
    if (!tab) {
      throw new BrowserError("target", "Browser has reached its 20-tab limit.");
    }
    this.activate(tab);
    return tab;
  }

  activate(tab: Tab): void {
    if (this.active !== tab) {
      this.invalidateRefs();
    }
    this.active = tab;
    tab.lastActive = this.nextActivation++;
  }

  async close(tab: Tab): Promise<void> {
    await tab.page.close();
    if (this.active === tab) {
      this.active = undefined;
      await this.recoverActive();
    }
  }

  async shutdown(): Promise<void> {
    this.shutdownTask ??= this.stop().finally(() => {
      this.shutdownTask = undefined;
    });
    return this.shutdownTask;
  }

  private async stop(): Promise<void> {
    this.accepting = false;
    await (this.activeAbort?.() ?? this.abortRuntime());
    await this.launch?.catch(() => {});
    await this.queue;
  }

  /** Stops a Playwright operation with no native per-call cancellation API. */
  async abortOperation(): Promise<void> {
    this.aborting = true;
    await this.abortRuntime();
  }

  private async waitForTurn(
    previous: Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!signal) {
      return previous;
    }
    await new Promise<void>((resolve, reject) => {
      const abort = () =>
        reject(
          new BrowserError(
            "cancelled",
            "Browser call was cancelled before dispatch.",
          ),
        );
      signal.addEventListener("abort", abort, { once: true });
      void previous
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
  }

  private async execute<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    this.dispatchedMutation = undefined;
    let aborted = false;
    let abortTask: Promise<void> | undefined;
    const abort = () => {
      aborted = true;
      this.aborting = true;
      abortTask ??= this.abortRuntime();
      return abortTask;
    };
    this.activeAbort = abort;
    const listener = () => void abort();
    signal?.addEventListener("abort", listener, { once: true });
    try {
      const result = await operation();
      if (aborted || signal?.aborted) {
        throw this.cancellationError();
      }
      return result;
    } catch (error) {
      if (aborted || signal?.aborted) {
        if (
          error instanceof BrowserError &&
          error.category === "uncertain_outcome"
        ) {
          throw error;
        }
        throw this.cancellationError(error);
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", listener);
      if (this.activeAbort === abort) {
        this.activeAbort = undefined;
      }
      await abortTask;
      this.dispatchedMutation = undefined;
      this.aborting = false;
    }
  }

  private cancellationError(error?: unknown): BrowserError {
    const details = error instanceof BrowserError ? error.details : {};
    if (this.dispatchedMutation) {
      return this.withContext(
        new BrowserError(
          "uncertain_outcome",
          "Browser action may have completed before it was cancelled; observe the page before retrying.",
          details,
        ),
      );
    }
    return this.withContext(
      new BrowserError("cancelled", "Browser call was cancelled.", details),
    );
  }

  private async ensure(): Promise<void> {
    if (this.aborting) {
      throw new BrowserError("cancelled", "Browser call was cancelled.");
    }
    if (this.browser?.isConnected() && this.context) {
      return;
    }
    if (!this.accepting) {
      throw new BrowserError("cancelled", "Browser session is shutting down.");
    }
    this.launch ??= this.start(this.generation);
    try {
      await this.launch;
    } finally {
      this.launch = undefined;
    }
  }

  private async start(generation: number): Promise<void> {
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    try {
      browser = await this.browserType.launch({
        headless: true,
        timeout: LIMITS.launchMs,
      });
      this.startingBrowser = browser;
      this.assertCurrent(generation);
      browser.on("disconnected", () => {
        if (!this.expectedDisconnect) {
          this.generation += 1;
          this.disconnectGeneration = this.generation;
          this.invalidate(true);
        }
      });
      context = await browser.newContext({
        viewport: LIMITS.defaultViewport,
        deviceScaleFactor: 1,
        acceptDownloads: false,
      });
      context.setDefaultTimeout(LIMITS.elementMs);
      context.setDefaultNavigationTimeout(LIMITS.navigationMs);
      this.assertCurrent(generation);
      context.on("page", (page) => this.own(page));
      this.browser = browser;
      this.context = context;
      this.startingBrowser = undefined;
      this.diagnostics = [];
      const page = await context.newPage();
      this.assertCurrent(generation);
      const tab = this.own(page);
      if (!tab) {
        throw new BrowserError(
          "backend",
          "Browser could not create its initial tab.",
        );
      }
      this.activate(tab);
    } catch (error) {
      if (this.browser === browser) {
        this.invalidate(false);
      }
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
      if (this.startingBrowser === browser) {
        this.startingBrowser = undefined;
      }
      throw browserError(error);
    }
  }

  private assertCurrent(generation: number): void {
    if (!this.accepting || generation !== this.generation) {
      throw new BrowserError("cancelled", "Browser session is shutting down.");
    }
  }

  private own(page: Page): Tab | undefined {
    const existing = this.tabs.get(page);
    if (existing) {
      return existing;
    }
    if (this.liveTabs().length >= LIMITS.tabCount) {
      void page.close().catch(() => {});
      return undefined;
    }
    const tab: Tab = {
      id: `tab-${this.nextTab++}`,
      page,
      lastActive: this.nextActivation++,
    };
    this.tabs.set(page, tab);
    this.actionPages?.push(tab);
    page.on("console", (message) => {
      if (["warning", "error"].includes(message.type())) {
        this.record({
          category: "console",
          message: message.text(),
          url: message.location().url,
          tabId: tab.id,
        });
      }
    });
    page.on("pageerror", (error) =>
      this.record({
        category: "page_error",
        message: error.message,
        tabId: tab.id,
      }),
    );
    page.on("requestfailed", (request) =>
      this.record({
        category: "request_failed",
        message: request.failure()?.errorText ?? "Request failed",
        url: request.url(),
        method: request.method(),
        tabId: tab.id,
      }),
    );
    page.on("response", (response) => {
      if (response.status() >= 400) {
        this.record({
          category: "http_error",
          message: `HTTP ${response.status()}`,
          url: response.url(),
          status: response.status(),
          tabId: tab.id,
        });
      }
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        this.invalidateRefs(page);
      }
    });
    page.on("close", () => {
      this.tabs.delete(page);
      this.invalidateRefs(page);
      if (this.active === tab) {
        this.active = undefined;
        this.activeChange = "Active tab closed; selected a fallback tab.";
        void this.recoverActive();
      }
    });
    return tab;
  }

  private record(record: Omit<Diagnostic, "sequence">): void {
    this.diagnostics.push({
      ...record,
      sequence: this.sequence++,
      message: bounded(
        this.redactText(record.message),
        LIMITS.diagnosticMessageChars,
      ),
      url: record.url ? this.redactText(sanitizeUrl(record.url)) : undefined,
    });
    if (this.diagnostics.length > LIMITS.diagnosticRetention) {
      this.diagnostics.splice(
        0,
        this.diagnostics.length - LIMITS.diagnosticRetention,
      );
    }
  }

  private recoverActive(): Promise<void> {
    this.activeRecovery ??= this.ensureActive().finally(() => {
      this.activeRecovery = undefined;
    });
    return this.activeRecovery;
  }

  private async ensureActive(): Promise<void> {
    const candidate = this.liveTabs().sort(
      (a, b) => b.lastActive - a.lastActive,
    )[0];
    if (candidate) {
      this.activate(candidate);
      return;
    }
    if (this.context && this.browser?.isConnected()) {
      const tab = this.own(await this.context.newPage());
      if (tab) {
        this.activate(tab);
      }
      this.activeChange = "Active tab closed; opened a fresh blank tab.";
    }
  }

  private async abortRuntime(): Promise<void> {
    this.generation += 1;
    const context = this.context;
    const browser = this.browser;
    const starting = this.startingBrowser;
    this.expectedDisconnect = true;
    this.invalidate(Boolean(context || browser || starting));
    try {
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
      if (starting && starting !== browser) {
        await starting.close().catch(() => {});
      }
    } finally {
      this.expectedDisconnect = false;
    }
  }

  private invalidate(lostState: boolean): void {
    if (lostState && (this.context || this.browser || this.tabs.size)) {
      this.stateLost = true;
    }
    this.browser = undefined;
    this.context = undefined;
    this.startingBrowser = undefined;
    this.active = undefined;
    this.activeRecovery = undefined;
    this.actionPages = undefined;
    this.invalidateRefs();
    this.tabs.clear();
    this.diagnostics = [];
    this.sensitiveTexts.clear();
  }
}

export function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return bounded(url.toString(), LIMITS.urlChars);
  } catch {
    return "about:blank";
  }
}
export function bounded(value: string, maximum: number): string {
  return Array.from(value).slice(0, maximum).join("");
}
