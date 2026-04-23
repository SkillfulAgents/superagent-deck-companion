import { SessionActivityMonitor } from "./session-activity-monitor.js";
import type { AgentInfo, ApiAgent, ActivityDetail, ActivityStatus, SSEEvent, UserSettingsData } from "./types.js";

export type AgentChangeHandler = (agents: AgentInfo[]) => void;
export type AgentCompleteHandler = (agentName: string, agentSlug: string) => void;
export type ApiLostHandler = () => void;

const POLL_FAILURE_THRESHOLD = 5;
// If the SSE stream goes silent for longer than this we assume the socket is
// half-open (laptop sleep, NAT flap, etc.) and force a reconnect.
const SSE_IDLE_TIMEOUT_MS = 30_000;
const SSE_BACKOFF_BASE_MS = 1_000;
const SSE_BACKOFF_MAX_MS = 30_000;

function applyAgentOrder(agents: AgentInfo[], savedOrder: string[] | undefined): AgentInfo[] {
	if (!savedOrder || savedOrder.length === 0) return agents;

	const positionMap = new Map(savedOrder.map((slug, index) => [slug, index]));
	const ordered: AgentInfo[] = [];
	const newAgents: AgentInfo[] = [];

	for (const agent of agents) {
		if (positionMap.has(agent.slug)) {
			ordered.push(agent);
		} else {
			newAgents.push(agent);
		}
	}

	ordered.sort((a, b) => positionMap.get(a.slug)! - positionMap.get(b.slug)!);
	return [...newAgents, ...ordered];
}

export class AgentMonitor {
	private agents: AgentInfo[] = [];
	private apiBase: string;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private sseAbort: AbortController | null = null;
	private onChange: AgentChangeHandler;
	private onComplete: AgentCompleteHandler;
	private onApiLost: ApiLostHandler | null = null;
	private consecutiveFailures = 0;
	private apiLostReported = false;
	private sessionActivityMonitor: SessionActivityMonitor;
	private activityDetails = new Map<string, { detail: ActivityDetail | null; sessionId: string | null }>();

	constructor(
		apiBaseUrl: string,
		onChange: AgentChangeHandler,
		onComplete: AgentCompleteHandler = () => {},
	) {
		this.apiBase = apiBaseUrl.replace(/\/$/, "");
		this.onChange = onChange;
		this.onComplete = onComplete;
		this.sessionActivityMonitor = new SessionActivityMonitor(this.apiBase, (agentSlug, detail, sessionId) => {
			this.setActivityDetail(agentSlug, detail, sessionId);
		});
	}

	setOnApiLost(handler: ApiLostHandler | null): void {
		this.onApiLost = handler;
	}

	async start(): Promise<void> {
		await this.poll();
		this.pollTimer = setInterval(() => this.poll(), 15_000);
		this.connectSSE();
	}

	stop(): void {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
		if (this.sseAbort) {
			this.sseAbort.abort();
			this.sseAbort = null;
		}
		this.sessionActivityMonitor.stop();
	}

	getAgents(): AgentInfo[] {
		return this.agents;
	}

	private async poll(): Promise<void> {
		try {
			const [agentsRes, settingsRes] = await Promise.all([
				fetch(`${this.apiBase}/api/agents`),
				fetch(`${this.apiBase}/api/user-settings`).catch(() => null),
			]);

			if (!agentsRes.ok) {
				this.registerPollFailure();
				return;
			}

			const raw = (await agentsRes.json()) as ApiAgent[];
			const agentOrder =
				settingsRes?.ok
					? ((await settingsRes.json()) as UserSettingsData | null)?.agentOrder
					: undefined;

			const agents = applyAgentOrder(raw.map((a) => ({
				slug: a.slug,
				name: a.name,
				activityStatus: this.deriveStatus(a),
			})), agentOrder);

			this.agents = agents.map((agent) => this.applyDetail(agent));
			this.onChange(this.agents);
			this.sessionActivityMonitor.updateAgents(this.agents);
			this.consecutiveFailures = 0;
			this.apiLostReported = false;
		} catch {
			this.registerPollFailure();
		}
	}

	private registerPollFailure(): void {
		this.consecutiveFailures += 1;
		if (this.consecutiveFailures >= POLL_FAILURE_THRESHOLD && !this.apiLostReported) {
			this.apiLostReported = true;
			console.warn(`[AgentMonitor] Lost SuperAgent API after ${this.consecutiveFailures} consecutive poll failures.`);
			this.onApiLost?.();
		}
	}

	private deriveStatus(agent: ApiAgent): ActivityStatus {
		if (agent.status === "stopped") return "sleeping";
		if (agent.hasSessionsAwaitingInput) return "awaiting_input";
		if (agent.hasActiveSessions) return "working";
		return "idle";
	}

	private connectSSE(): void {
		this.sseAbort?.abort();
		this.sseAbort = new AbortController();

		const url = `${this.apiBase}/api/notifications/stream`;
		let attempt = 0;
		let watchdog: ReturnType<typeof setTimeout> | null = null;

		const armWatchdog = () => {
			if (watchdog) clearTimeout(watchdog);
			watchdog = setTimeout(() => {
				console.warn("[AgentMonitor] SSE idle timeout, forcing reconnect.");
				this.sseAbort?.abort();
				this.sseAbort = new AbortController();
			}, SSE_IDLE_TIMEOUT_MS);
		};

		const connect = async () => {
			try {
				armWatchdog();
				const res = await fetch(url, {
					signal: this.sseAbort!.signal,
					headers: { Accept: "text/event-stream" },
				});

				if (!res.ok || !res.body) {
					scheduleReconnect();
					return;
				}

				attempt = 0;
				const reader = res.body.getReader();
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
						const json = line.slice(5).trim();
						if (!json) continue;

						try {
							const event: SSEEvent = JSON.parse(json);
							this.handleSSEEvent(event);
						} catch {
							// ignore malformed
						}
					}
				}
			} catch (err: unknown) {
				if (err instanceof Error && err.name === "AbortError" && this.sseAbortIntentional()) return;
			} finally {
				if (watchdog) clearTimeout(watchdog);
				watchdog = null;
			}

			scheduleReconnect();
		};

		const scheduleReconnect = () => {
			if (this.sseAbortIntentional()) return;
			attempt += 1;
			const backoff = Math.min(SSE_BACKOFF_MAX_MS, SSE_BACKOFF_BASE_MS * 2 ** (attempt - 1));
			const jitter = backoff * 0.3 * Math.random();
			setTimeout(() => connect(), backoff + jitter);
		};

		connect();
	}

	/**
	 * Distinguishes "user asked us to stop" from "our own watchdog aborted".
	 * The watchdog recreates the abort controller before triggering so any
	 * abort we see here with no controller present was a genuine stop() call.
	 */
	private sseAbortIntentional(): boolean {
		return this.sseAbort === null;
	}

	private handleSSEEvent(event: SSEEvent): void {
		const slug = event.agentSlug;
		if (!slug) return;

		const prevAgent = this.agents.find((a) => a.slug === slug);
		if (!prevAgent) return;

		const nextStatus = this.deriveStatusFromEvent(event, prevAgent.activityStatus);
		if (nextStatus === null || nextStatus === prevAgent.activityStatus) return;

		// Produce a new object rather than mutating in place; keeps reference
		// equality meaningful for any downstream diffing.
		this.agents = this.agents.map((a) => (a.slug === slug ? { ...a, activityStatus: nextStatus } : a));

		if (prevAgent.activityStatus === "working" && nextStatus !== "working") {
			this.onComplete(prevAgent.name, prevAgent.slug);
		}
		this.onChange(this.agents);
		this.sessionActivityMonitor.requestSync();
	}

	private deriveStatusFromEvent(event: SSEEvent, current: ActivityStatus): ActivityStatus | null {
		switch (event.type) {
			case "session_active":
				return current === "working" ? null : "working";
			case "session_idle":
				return current === "working" || current === "awaiting_input" ? "idle" : null;
			case "session_awaiting_input":
				return current === "awaiting_input" ? null : "awaiting_input";
			case "session_input_provided":
				return current === "awaiting_input" ? "working" : null;
			case "session_error":
				return current === "idle" ? null : "idle";
			default:
				return null;
		}
	}

	private applyDetail(agent: AgentInfo): AgentInfo {
		const detail = this.activityDetails.get(agent.slug);
		return {
			...agent,
			activityDetail: detail?.detail ?? null,
			currentSessionId: detail?.sessionId ?? null,
		};
	}

	private setActivityDetail(agentSlug: string, detail: ActivityDetail | null, sessionId: string | null): void {
		this.activityDetails.set(agentSlug, { detail, sessionId });

		let changed = false;
		this.agents = this.agents.map((agent) => {
			if (agent.slug !== agentSlug) return agent;
			if (agent.activityDetail === detail && agent.currentSessionId === sessionId) return agent;
			changed = true;
			return {
				...agent,
				activityDetail: detail,
				currentSessionId: sessionId,
			};
		});

		if (changed) {
			this.onChange([...this.agents]);
		}
	}
}
