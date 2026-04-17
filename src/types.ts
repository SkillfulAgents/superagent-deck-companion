export type ActivityStatus = "working" | "idle" | "sleeping" | "awaiting_input";
export type ActivityDetail = "browser_use" | "computer_use" | "compacting";
export type VisualStatus = ActivityStatus | ActivityDetail;

export interface AgentInfo {
	slug: string;
	name: string;
	activityStatus: ActivityStatus;
	activityDetail?: ActivityDetail | null;
	currentSessionId?: string | null;
}

export interface ApiAgent {
	slug: string;
	name: string;
	status: "running" | "stopped";
	hasActiveSessions: boolean;
	hasSessionsAwaitingInput: boolean;
}

export interface SSEEvent {
	type: string;
	sessionId?: string;
	agentSlug?: string;
}

export interface ApiSession {
	id: string;
	lastActivityAt: string;
	isActive?: boolean;
	isAwaitingInput?: boolean;
}

export interface SessionSSEEvent {
	type: string;
	sessionId?: string;
	agentSlug?: string;
	active?: boolean;
	toolUseId?: string;
	app?: string | null;
	appIcon?: string;
}

export interface ButtonState {
	agent: AgentInfo | null;
	index: number;
}
