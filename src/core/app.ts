import { AgentMonitor } from "../agent-monitor.js";
import {
	renderButtonFrame,
	renderEmptyStateCard,
	getPageButtonColor,
	renderSparkline,
} from "../button-renderer.js";
import { resolveRuntimeConfig } from "../config.js";
import { CompanionError, ExitCode } from "../errors.js";
import { isOfficialStreamDeckAppRunning, openDeepLink } from "../platform-utils.js";
import type { AgentInfo } from "../types.js";
import { UsageMonitor, type UsageData } from "../usage-monitor.js";
import { ElgatoStreamDeckNeoDevice } from "../devices/elgato-stream-deck-neo-device.js";
import type { CompanionDevice } from "../devices/device.js";
import { StateStore } from "../state-store.js";

const BUTTONS_PER_PAGE = 8;
const ANIM_FPS = 10;
const ANIM_INTERVAL_MS = 1000 / ANIM_FPS;
const SPARKLINE_REFRESH_MS = 3000;
const COMPLETION_FLASH_DURATION_S = 1.2;

export class CompanionApp {
	private readonly device: CompanionDevice;
	private readonly stateStore = new StateStore();
	private agentMonitor!: AgentMonitor;
	private usageMonitor!: UsageMonitor;
	private protocol = "superagent";
	private allAgents: AgentInfo[] = [];
	private currentPage = 0;
	private totalPages = 1;
	private animTime = 0;
	private animTimer: ReturnType<typeof setInterval> | null = null;
	private tickerRunning = false;
	private tickerAbort = false;
	private sparklineWake: (() => void) | null = null;
	private focusedAgentSlug: string | null = null;
	private renderLock = false;
	private shuttingDown = false;
	/** Map of agentSlug -> animTime at which the flash started */
	private completionFlashStartedAt = new Map<string, number>();

	constructor(device: CompanionDevice = new ElgatoStreamDeckNeoDevice()) {
		this.device = device;
	}

	async start(): Promise<void> {
		console.log("Starting SuperAgent Stream Deck Companion...\n");

		await this.stateStore.init();
		this.currentPage = this.stateStore.state.currentPage;
		this.focusedAgentSlug = this.stateStore.state.focusedAgentSlug;

		const runtimeConfig = await this.bootstrapRuntime();
		await this.connectDevice();
		await this.startSuperAgentSync(runtimeConfig.apiBaseUrl);
		this.startRenderLoop();
		this.registerShutdownHandlers();
		void this.runTickerLoop();

		console.log(`\nMonitoring ${this.allAgents.length} agents on port ${runtimeConfig.apiPort}`);
		console.log("◀ ▶ = page | Press = navigate to agent\n");
	}

	private async bootstrapRuntime() {
		const runtimeConfig = await resolveRuntimeConfig();
		this.protocol = runtimeConfig.protocol;

		console.log(`[Startup] SuperAgent API: ${runtimeConfig.apiBaseUrl}`);
		console.log(`[Startup] Deep link protocol: ${this.protocol}`);
		if (runtimeConfig.configPath) {
			console.log(`[Startup] Loaded config: ${runtimeConfig.configPath}`);
		}

		if (await isOfficialStreamDeckAppRunning()) {
			console.log("[Startup] Detected the official Elgato Stream Deck app. Please close it if the device is busy.");
		}

		return runtimeConfig;
	}

	private async connectDevice(): Promise<void> {
		await this.device.connect();
		this.device.setOnRelease((buttonIndex) => this.handleButtonUp(buttonIndex));
		this.device.setOnSwipe((from, to) => this.handleSwipe(from, to));
		this.device.setOnDisconnect((error) => this.handleDeviceDisconnect(error));
	}

	private deviceReconnectInFlight = false;
	/**
	 * Triggered when the device layer reports a write error or HID-level
	 * disconnect. Pauses the render loop and retries connect() every few
	 * seconds until the device shows up again. Typically caused by an unplug
	 * or the user starting the official Stream Deck app mid-session.
	 */
	private async handleDeviceDisconnect(error: Error): Promise<void> {
		if (this.shuttingDown || this.deviceReconnectInFlight) return;
		this.deviceReconnectInFlight = true;

		console.warn(`[Device] Disconnected: ${error.message}. Attempting to reconnect...`);
		if (this.animTimer) {
			clearInterval(this.animTimer);
			this.animTimer = null;
		}

		let attempt = 0;
		while (!this.shuttingDown) {
			attempt += 1;
			try {
				await this.device.connect();
				this.device.setOnRelease((buttonIndex) => this.handleButtonUp(buttonIndex));
				this.device.setOnSwipe((from, to) => this.handleSwipe(from, to));
				this.device.setOnDisconnect((err) => this.handleDeviceDisconnect(err));
				console.log(`[Device] Reconnected on attempt ${attempt}.`);
				this.startRenderLoop();
				void this.renderAll();
				this.deviceReconnectInFlight = false;
				return;
			} catch (err) {
				const delay = Math.min(15_000, 2_000 * Math.min(attempt, 6));
				console.warn(`[Device] Reconnect attempt ${attempt} failed (${(err as Error).message}). Retrying in ${delay}ms.`);
				await this.sleep(delay);
			}
		}

		this.deviceReconnectInFlight = false;
	}

	private async startSuperAgentSync(apiBaseUrl: string): Promise<void> {
		this.agentMonitor = new AgentMonitor(
			apiBaseUrl,
			(agents) => this.handleAgentUpdate(agents),
			(name, slug) => this.handleAgentComplete(name, slug),
		);
		this.agentMonitor.setOnApiLost(() => void this.rediscoverSuperAgent());
		await this.agentMonitor.start();

		this.usageMonitor = new UsageMonitor(apiBaseUrl, (usage) => this.handleUsageUpdate(usage));
		await this.usageMonitor.start();
	}

	/**
	 * Triggered when `AgentMonitor` reports extended API loss.
	 * Tears down the current monitors, re-runs config discovery, and rebuilds
	 * the sync pipeline. Retries with exponential-ish backoff on failure.
	 */
	private rediscoverInFlight = false;
	private async rediscoverSuperAgent(attempt = 1): Promise<void> {
		if (this.rediscoverInFlight || this.shuttingDown) return;
		this.rediscoverInFlight = true;

		try {
			console.log(`[Recovery] Attempt ${attempt}: searching for SuperAgent API...`);
			this.agentMonitor?.stop();
			this.usageMonitor?.stop();
			this.allAgents = [];
			void this.renderAll();

			const runtime = await resolveRuntimeConfig();
			this.protocol = runtime.protocol;
			await this.startSuperAgentSync(runtime.apiBaseUrl);
			console.log(`[Recovery] Reconnected to SuperAgent at ${runtime.apiBaseUrl}`);
		} catch (error) {
			const delay = Math.min(30_000, 3_000 * attempt);
			console.warn(`[Recovery] Rediscovery failed (${(error as Error).message}). Retrying in ${delay}ms.`);
			setTimeout(() => {
				this.rediscoverInFlight = false;
				void this.rediscoverSuperAgent(attempt + 1);
			}, delay);
			return;
		}

		this.rediscoverInFlight = false;
	}

	private startRenderLoop(): void {
		this.animTimer = setInterval(() => {
			this.animTime += 1 / ANIM_FPS;
			void this.renderAllButtons();
		}, ANIM_INTERVAL_MS);
	}

	private registerShutdownHandlers(): void {
		process.on("SIGINT", () => void this.shutdown(0, "SIGINT"));
		process.on("SIGTERM", () => void this.shutdown(0, "SIGTERM"));
		process.on("uncaughtException", (error) => {
			console.error("[Fatal] uncaughtException:", error);
			void this.shutdown(1, "uncaughtException");
		});
		process.on("unhandledRejection", (reason) => {
			console.error("[Fatal] unhandledRejection:", reason);
			void this.shutdown(1, "unhandledRejection");
		});
	}

	/**
	 * Orchestrated shutdown. Always called for SIGINT/SIGTERM as well as
	 * uncaughtException / unhandledRejection so the device is cleared and the
	 * persisted state is flushed no matter how we exit. The 3s safety timer
	 * guarantees we don't hang forever if something is wedged.
	 */
	private async shutdown(exitCode: number, reason: string): Promise<void> {
		if (this.shuttingDown) return;
		this.shuttingDown = true;
		console.log(`\nShutting down (${reason})...`);

		const forceExit = setTimeout(() => {
			console.warn("[Shutdown] Timed out waiting for cleanup, forcing exit.");
			process.exit(exitCode);
		}, 3_000);
		forceExit.unref();

		this.tickerAbort = true;
		try { this.agentMonitor?.stop(); } catch {}
		try { this.usageMonitor?.stop(); } catch {}
		if (this.animTimer) clearInterval(this.animTimer);
		try { await this.stateStore.flush(); } catch {}
		try { await this.device.close(); } catch {}

		clearTimeout(forceExit);
		process.exit(exitCode);
	}

	private getPageAgents(): (AgentInfo | null)[] {
		const start = this.currentPage * BUTTONS_PER_PAGE;
		return Array.from({ length: BUTTONS_PER_PAGE }, (_, index) => this.allAgents[start + index] ?? null);
	}

	private setPage(page: number): void {
		const clamped = Math.max(0, Math.min(this.totalPages - 1, page));
		if (clamped === this.currentPage) return;
		this.currentPage = clamped;
		this.stateStore.update({ currentPage: clamped });
		void this.renderAll();
	}

	private setFocusedAgent(slug: string | null): void {
		if (this.focusedAgentSlug === slug) return;
		this.focusedAgentSlug = slug;
		this.stateStore.update({ focusedAgentSlug: slug });
	}

	private handleAgentUpdate(agents: AgentInfo[]): void {
		this.allAgents = agents;
		this.totalPages = Math.max(1, Math.ceil(agents.length / BUTTONS_PER_PAGE));
		if (this.currentPage >= this.totalPages) {
			this.currentPage = this.totalPages - 1;
			this.stateStore.update({ currentPage: this.currentPage });
		}

		// If the focused agent was removed or renamed away, drop the reference
		// so we don't keep trying to highlight a ghost.
		if (this.focusedAgentSlug && !agents.some((agent) => agent.slug === this.focusedAgentSlug)) {
			this.setFocusedAgent(null);
		}

		void this.renderAll();

		const summary = agents.map((agent) => `  ${agent.name}: ${agent.activityStatus}${agent.activityDetail ? ` (${agent.activityDetail})` : ""}`).join("\n");
		console.log(`[Update] ${agents.length} agents (page ${this.currentPage + 1}/${this.totalPages}):\n${summary}\n`);
	}

	private handleAgentComplete(agentName: string, agentSlug: string): void {
		console.log(`[Complete] ${agentName} finished`);
		this.completionFlashStartedAt.set(agentSlug, this.animTime);
	}

	private getCompletionFlashStrength(agentSlug: string): number {
		const startedAt = this.completionFlashStartedAt.get(agentSlug);
		if (startedAt === undefined) return 0;

		const elapsed = this.animTime - startedAt;
		if (elapsed < 0 || elapsed >= COMPLETION_FLASH_DURATION_S) {
			this.completionFlashStartedAt.delete(agentSlug);
			return 0;
		}

		return 1 - elapsed / COMPLETION_FLASH_DURATION_S;
	}

	private handleUsageUpdate(_usage: UsageData): void {
		const today = this.usageMonitor.getToday();
		if (!today) return;
		console.log(`[Usage] Today: $${today.totalCost.toFixed(4)} | ${today.totalTokens.toLocaleString()} tokens`);
	}

	private async renderAll(): Promise<void> {
		await Promise.all([this.renderAllButtons(), this.renderPageIndicators()]);
	}

	private async renderAllButtons(): Promise<void> {
		if (this.renderLock) return;
		this.renderLock = true;

		try {
			const lcdButtons = this.device.getLcdButtons();
			const buttons = lcdButtons.slice(0, BUTTONS_PER_PAGE);
			const pageAgents = this.getPageAgents();
			const showEmptyState = this.allAgents.length === 0;

			const renders = buttons.map((button, index) => {
				if (showEmptyState && index === 0) {
					return renderEmptyStateCard(button.width, button.height, this.animTime);
				}
				const agent = pageAgents[index];
				const isSelected = agent != null && agent.slug === this.focusedAgentSlug;
				const flashStrength = agent ? this.getCompletionFlashStrength(agent.slug) : 0;
				return renderButtonFrame(
					agent,
					button.width,
					button.height,
					this.animTime,
					isSelected,
					flashStrength,
				);
			});

			const buffers = await Promise.all(renders);
			await Promise.all(
				buffers.map((buffer, index) => this.device.fillLcdButton(buttons[index].index, buffer)),
			);
		} finally {
			this.renderLock = false;
		}
	}

	private async renderPageIndicators(): Promise<void> {
		const rgbButtons = this.device.getRgbButtonIndices();
		if (rgbButtons.length < 2) return;

		const leftColor = getPageButtonColor("left", this.currentPage, this.totalPages);
		const rightColor = getPageButtonColor("right", this.currentPage, this.totalPages);

		await this.device.fillRgbButton(rgbButtons[0], leftColor.r, leftColor.g, leftColor.b);
		await this.device.fillRgbButton(rgbButtons[1], rightColor.r, rightColor.g, rightColor.b);
	}

	private forceSparklineRefresh(): void {
		if (this.sparklineWake) this.sparklineWake();
	}

	private async runTickerLoop(): Promise<void> {
		if (this.tickerRunning) return;
		this.tickerRunning = true;

		while (!this.tickerAbort) {
			const segment = this.device.getLcdSegment();
			if (!segment) {
				await this.sleep(500);
				continue;
			}

			let name: string;
			let series: { date: string; tokens: number }[];

			if (this.focusedAgentSlug) {
				const agent = this.allAgents.find((item) => item.slug === this.focusedAgentSlug);
				name = agent?.name ?? this.focusedAgentSlug;
				series = this.usageMonitor.getAgentSeries(this.focusedAgentSlug);
			} else {
				name = "All Agents";
				series = this.getTotalSeries();
			}

			if (series.length > 0) {
				const buffer = await renderSparkline(segment.width, segment.height, name, series);
				await this.device.fillLcdBar(buffer);
			}

			await this.interruptibleSleep(SPARKLINE_REFRESH_MS);
		}

		this.tickerRunning = false;
	}

	private getTotalSeries(): { date: string; tokens: number }[] {
		const data = this.usageMonitor.getLatest();
		if (!data) return [];
		return data.daily.map((day) => ({ date: day.date, tokens: day.totalTokens }));
	}

	private interruptibleSleep(ms: number): Promise<void> {
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.sparklineWake = null;
				resolve();
			}, ms);

			this.sparklineWake = () => {
				clearTimeout(timer);
				this.sparklineWake = null;
				resolve();
			};
		});
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	private handleButtonUp(buttonIndex: number): void {
		const rgbButtons = this.device.getRgbButtonIndices();
		if (rgbButtons.includes(buttonIndex)) {
			const side = buttonIndex === rgbButtons[0] ? "left" : "right";
			this.setPage(side === "left" ? this.currentPage - 1 : this.currentPage + 1);
			return;
		}

		const lcdButtons = this.device.getLcdButtons();
		const agentIndex = lcdButtons.findIndex((button) => button.index === buttonIndex);
		if (agentIndex < 0) return;

		const agent = this.getPageAgents()[agentIndex];
		if (!agent) {
			console.log(`[Press] Button #${buttonIndex} — no agent assigned`);
			return;
		}

		this.setFocusedAgent(agent.slug);
		this.forceSparklineRefresh();

		// If the agent is currently awaiting input, jump straight to the
		// specific session that needs attention rather than the agent overview.
		const targetSessionId = agent.activityStatus === "awaiting_input"
			? agent.currentSessionId ?? null
			: null;

		console.log(
			`[Press] -> "${agent.name}" (${agent.slug})${targetSessionId ? ` session ${targetSessionId}` : ""}`,
		);
		void this.openAgentDeepLink(agent.slug, targetSessionId).catch((error) => {
			console.error("[Navigate] Failed:", error);
		});
	}

	private handleSwipe(from: { x: number }, to: { x: number }): void {
		const deltaX = to.x - from.x;
		if (Math.abs(deltaX) < 20) return;
		this.setPage(deltaX < 0 ? this.currentPage + 1 : this.currentPage - 1);
	}

	private async openAgentDeepLink(slug: string, sessionId: string | null = null): Promise<void> {
		const path = sessionId
			? `agent/${encodeURIComponent(slug)}/session/${encodeURIComponent(sessionId)}`
			: `agent/${encodeURIComponent(slug)}`;
		await openDeepLink(path, this.protocol);
	}
}

export async function startCompanionApp(): Promise<void> {
	const app = new CompanionApp();
	await app.start();
}

export function handleFatalError(error: unknown): never {
	if (error instanceof CompanionError) {
		console.error(`[${error.code}] ${error.message}`);
		if (error.details) console.error(error.details);
		process.exit(error.exitCode);
	}

	console.error("Fatal error:", error);
	process.exit(ExitCode.StartupFailure);
}
