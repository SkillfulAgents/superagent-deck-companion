export interface AgentDayUsage {
	agentSlug: string;
	agentName: string;
	cost: number;
	totalTokens: number;
}

export interface DailyEntry {
	date: string;
	totalCost: number;
	totalTokens: number;
	byAgent: AgentDayUsage[];
	byModel: { model: string; cost: number }[];
}

export interface UsageData {
	daily: DailyEntry[];
}

export class UsageMonitor {
	private apiBase: string;
	private latest: UsageData | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;
	private onChange: (usage: UsageData) => void;

	constructor(apiBaseUrl: string, onChange: (usage: UsageData) => void) {
		this.apiBase = apiBaseUrl.replace(/\/$/, "");
		this.onChange = onChange;
	}

	async start(): Promise<void> {
		await this.poll();
		this.timer = setInterval(() => this.poll(), 30_000);
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	getLatest(): UsageData | null { return this.latest; }

	getToday(): DailyEntry | null {
		if (!this.latest || this.latest.daily.length === 0) return null;
		return this.latest.daily[this.latest.daily.length - 1];
	}

	getAgentSeries(agentSlug: string): { date: string; tokens: number }[] {
		if (!this.latest) return [];
		return this.latest.daily.map((d) => {
			const agentEntry = d.byAgent.find((a) => a.agentSlug === agentSlug);
			return { date: d.date, tokens: agentEntry?.totalTokens ?? 0 };
		});
	}

	private async poll(): Promise<void> {
		try {
			const res = await fetch(`${this.apiBase}/api/usage?days=7`);
			if (!res.ok) return;

			const data = await res.json() as { daily: DailyEntry[] };
			if (!data.daily) return;

			data.daily.sort((a, b) => a.date.localeCompare(b.date));
			this.latest = data;
			this.onChange(this.latest);
		} catch {
			// API not reachable
		}
	}
}
