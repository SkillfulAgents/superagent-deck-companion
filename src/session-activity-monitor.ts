import type { ActivityDetail, AgentInfo, ApiSession, SessionSSEEvent } from "./types.js";

type DetailChangeHandler = (agentSlug: string, detail: ActivityDetail | null, sessionId: string | null) => void;

interface SessionWatcherState {
	browserActive: boolean;
	computerUseActive: boolean;
	compacting: boolean;
}

// Delay before we believe an idle/error really means "no more activity".
// Prevents a brief flicker of browser_use → idle → browser_use when the stream
// momentarily reports idle between rapid tool invocations.
const IDLE_CLEAR_DELAY_MS = 350;
const SSE_IDLE_TIMEOUT_MS = 30_000;
const SSE_BACKOFF_BASE_MS = 1_000;
const SSE_BACKOFF_MAX_MS = 30_000;

class SessionStreamWatcher {
	private readonly apiBaseUrl: string;
	private readonly agentSlug: string;
	private readonly sessionId: string;
	private readonly onDetailChange: DetailChangeHandler;
	private abortController: AbortController | null = null;
	private state: SessionWatcherState = { browserActive: false, computerUseActive: false, compacting: false };
	private emittedDetail: ActivityDetail | null = null;
	private pendingIdleClear: ReturnType<typeof setTimeout> | null = null;
	private stopped = false;

	constructor(apiBaseUrl: string, agentSlug: string, sessionId: string, onDetailChange: DetailChangeHandler) {
		this.apiBaseUrl = apiBaseUrl.replace(/\/$/, "");
		this.agentSlug = agentSlug;
		this.sessionId = sessionId;
		this.onDetailChange = onDetailChange;
	}

	start(): void {
		void this.bootstrap();
		this.connect();
	}

	getSessionId(): string {
		return this.sessionId;
	}

	stop(): void {
		this.stopped = true;
		this.abortController?.abort();
		this.abortController = null;
		this.cancelPendingIdleClear();
		this.state = { browserActive: false, computerUseActive: false, compacting: false };
		this.emit(null);
	}

	private async bootstrap(): Promise<void> {
		try {
			const response = await fetch(`${this.apiBaseUrl}/api/agents/${encodeURIComponent(this.agentSlug)}/browser/status`);
			if (!response.ok) return;

			const data = await response.json() as { active?: boolean; sessionId?: string | null };
			if (data.active && data.sessionId === this.sessionId) {
				this.state.browserActive = true;
				this.emitCurrent();
			}
		} catch {
			// Best effort bootstrap only.
		}
	}

	private connect(): void {
		this.abortController?.abort();
		this.abortController = new AbortController();
		const url = `${this.apiBaseUrl}/api/agents/${encodeURIComponent(this.agentSlug)}/sessions/${encodeURIComponent(this.sessionId)}/stream`;
		let attempt = 0;
		let watchdog: ReturnType<typeof setTimeout> | null = null;

		const armWatchdog = () => {
			if (watchdog) clearTimeout(watchdog);
			watchdog = setTimeout(() => {
				this.abortController?.abort();
				this.abortController = new AbortController();
			}, SSE_IDLE_TIMEOUT_MS);
		};

		const scheduleReconnect = () => {
			if (this.stopped) return;
			attempt += 1;
			const backoff = Math.min(SSE_BACKOFF_MAX_MS, SSE_BACKOFF_BASE_MS * 2 ** (attempt - 1));
			const jitter = backoff * 0.3 * Math.random();
			setTimeout(() => run(), backoff + jitter);
		};

		const run = async () => {
			try {
				armWatchdog();
				const response = await fetch(url, {
					signal: this.abortController!.signal,
					headers: { Accept: "text/event-stream" },
				});

				if (!response.ok || !response.body) {
					scheduleReconnect();
					return;
				}

				attempt = 0;
				const reader = response.body.getReader();
				const decoder = new TextDecoder();
				let buffer = "";

				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					armWatchdog();

					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split("\n");
					buffer = lines.pop() ?? "";

					for (const line of lines) {
						if (!line.startsWith("data:")) continue;
						const raw = line.slice(5).trim();
						if (!raw) continue;

						try {
							this.handleEvent(JSON.parse(raw) as SessionSSEEvent);
						} catch {
							// Ignore malformed event payloads.
						}
					}
				}
			} catch (error: unknown) {
				if (error instanceof Error && error.name === "AbortError" && this.stopped) return;
			} finally {
				if (watchdog) clearTimeout(watchdog);
				watchdog = null;
			}

			scheduleReconnect();
		};

		void run();
	}

	private handleEvent(event: SessionSSEEvent): void {
		// Any non-idle activity cancels a pending idle clear.
		if (event.type !== "session_idle" && event.type !== "session_error") {
			this.cancelPendingIdleClear();
		}

		switch (event.type) {
			case "browser_active":
				this.state.browserActive = !!event.active;
				break;
			case "computer_use_request":
				this.state.computerUseActive = true;
				break;
			case "computer_use_grab_changed":
				this.state.computerUseActive = event.app != null;
				break;
			case "compact_start":
				this.state.compacting = true;
				break;
			case "compact_complete":
				this.state.compacting = false;
				break;
			case "session_idle":
			case "session_error":
				this.scheduleIdleClear();
				return;
			default:
				return;
		}

		this.emitCurrent();
	}

	private scheduleIdleClear(): void {
		if (this.pendingIdleClear) return;
		this.pendingIdleClear = setTimeout(() => {
			this.pendingIdleClear = null;
			this.state = { browserActive: false, computerUseActive: false, compacting: false };
			this.emitCurrent();
		}, IDLE_CLEAR_DELAY_MS);
	}

	private cancelPendingIdleClear(): void {
		if (!this.pendingIdleClear) return;
		clearTimeout(this.pendingIdleClear);
		this.pendingIdleClear = null;
	}

	private emitCurrent(): void {
		if (this.state.compacting) {
			this.emit("compacting");
			return;
		}

		if (this.state.computerUseActive) {
			this.emit("computer_use");
			return;
		}

		if (this.state.browserActive) {
			this.emit("browser_use");
			return;
		}

		this.emit(null);
	}

	private emit(detail: ActivityDetail | null): void {
		if (this.emittedDetail === detail) return;
		this.emittedDetail = detail;
		this.onDetailChange(this.agentSlug, detail, this.sessionId);
	}
}

export class SessionActivityMonitor {
	private readonly apiBaseUrl: string;
	private readonly onDetailChange: DetailChangeHandler;
	private readonly watchers = new Map<string, SessionStreamWatcher>();
	private syncInFlight = false;
	private syncRequested = false;
	private latestAgents: AgentInfo[] = [];

	constructor(apiBaseUrl: string, onDetailChange: DetailChangeHandler) {
		this.apiBaseUrl = apiBaseUrl.replace(/\/$/, "");
		this.onDetailChange = onDetailChange;
	}

	updateAgents(agents: AgentInfo[]): void {
		this.latestAgents = agents;
		void this.sync();
	}

	requestSync(): void {
		void this.sync();
	}

	stop(): void {
		for (const watcher of this.watchers.values()) {
			watcher.stop();
		}
		this.watchers.clear();
	}

	private async sync(): Promise<void> {
		if (this.syncInFlight) {
			this.syncRequested = true;
			return;
		}

		this.syncInFlight = true;

		try {
			const nextActiveSessions = new Map<string, string | null>();
			const candidates = this.latestAgents.filter((agent) =>
				agent.activityStatus === "working" ||
				agent.activityStatus === "awaiting_input" ||
				this.watchers.has(agent.slug),
			);

			for (const agent of candidates) {
				const sessionId = await this.getLatestRelevantSessionId(agent.slug);
				nextActiveSessions.set(agent.slug, sessionId);
			}

			for (const agent of this.latestAgents) {
				if (!nextActiveSessions.has(agent.slug)) {
					nextActiveSessions.set(agent.slug, null);
				}
			}

			for (const [agentSlug, watcher] of this.watchers) {
				if (nextActiveSessions.has(agentSlug)) continue;
				watcher.stop();
				this.watchers.delete(agentSlug);
				this.onDetailChange(agentSlug, null, null);
			}

			for (const [agentSlug, nextSessionId] of nextActiveSessions) {
				const currentWatcher = this.watchers.get(agentSlug);
				const currentSessionId = this.getWatcherSessionId(currentWatcher);

				if (currentSessionId === nextSessionId) continue;

				currentWatcher?.stop();

				if (!nextSessionId) {
					this.watchers.delete(agentSlug);
					this.onDetailChange(agentSlug, null, null);
					continue;
				}

				const watcher = new SessionStreamWatcher(this.apiBaseUrl, agentSlug, nextSessionId, this.onDetailChange);
				this.watchers.set(agentSlug, watcher);
				this.onDetailChange(agentSlug, null, nextSessionId);
				watcher.start();
			}
		} finally {
			this.syncInFlight = false;
			if (this.syncRequested) {
				this.syncRequested = false;
				void this.sync();
			}
		}
	}

	private getWatcherSessionId(watcher: SessionStreamWatcher | undefined): string | null {
		if (!watcher) return null;
		return watcher.getSessionId();
	}

	private async getLatestRelevantSessionId(agentSlug: string): Promise<string | null> {
		try {
			const response = await fetch(`${this.apiBaseUrl}/api/agents/${encodeURIComponent(agentSlug)}/sessions`);
			if (!response.ok) return null;

			const sessions = await response.json() as ApiSession[];
			const candidates = sessions
				.filter((session) => session.isActive || session.isAwaitingInput)
				.sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));

			return candidates[0]?.id ?? null;
		} catch {
			return null;
		}
	}
}
