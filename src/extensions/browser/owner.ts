import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright-core";
import { BrowserError, browserError } from "./errors.js";
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
  private sequence = 1;
  private activeRecovery?: Promise<void>;
  private activeAbort?: () => Promise<void>;
  private aborting = false;
  private actionPages: Tab[] | undefined;
  private activeChange?: string;
  private stateLost = false;

  constructor(private readonly browserType: ChromiumFacade = chromium) {}

  async reset(): Promise<void> {
    await this.shutdown();
    this.accepting = true;
    this.nextTab = 1;
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
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
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
  consumeActiveChange(): string | undefined {
    const change = this.activeChange;
    this.activeChange = undefined;
    return change;
  }

  beginAction(): void {
    this.actionPages = [];
    this.activeChange = undefined;
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
    this.activate(tab);
    return tab;
  }

  activate(tab: Tab): void {
    this.active = tab;
    tab.lastActive = Date.now();
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
        throw new BrowserError("cancelled", "Browser call was cancelled.");
      }
      return result;
    } catch (error) {
      if (aborted || signal?.aborted) {
        throw new BrowserError("cancelled", "Browser call was cancelled.");
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", listener);
      if (this.activeAbort === abort) {
        this.activeAbort = undefined;
      }
      await abortTask;
      this.aborting = false;
    }
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
      browser.on("disconnected", () => this.invalidate(true));
      context = await browser.newContext({
        viewport: LIMITS.defaultViewport,
        deviceScaleFactor: 1,
        acceptDownloads: false,
      });
      this.assertCurrent(generation);
      context.on("page", (page) => this.own(page));
      this.browser = browser;
      this.context = context;
      this.startingBrowser = undefined;
      this.diagnostics = [];
      const page = await context.newPage();
      this.assertCurrent(generation);
      this.activate(this.own(page));
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

  private own(page: Page): Tab {
    const existing = this.tabs.get(page);
    if (existing) {
      return existing;
    }
    const tab: Tab = {
      id: `tab-${this.nextTab++}`,
      page,
      lastActive: Date.now(),
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
    page.on("close", () => {
      this.tabs.delete(page);
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
      message: bounded(record.message, LIMITS.diagnosticMessageChars),
      url: record.url ? sanitizeUrl(record.url) : undefined,
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
      this.activate(tab);
      this.activeChange = "Active tab closed; opened a fresh blank tab.";
    }
  }

  private async abortRuntime(): Promise<void> {
    this.generation += 1;
    const context = this.context;
    const browser = this.browser;
    const starting = this.startingBrowser;
    this.invalidate(Boolean(context || browser || starting));
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    if (starting && starting !== browser) {
      await starting.close().catch(() => {});
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
    this.tabs.clear();
    this.diagnostics = [];
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
