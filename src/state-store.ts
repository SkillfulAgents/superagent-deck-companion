import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Lightweight persisted UI state, survives companion restarts so the user
 * returns to the same page/focused agent they left.
 */
export interface CompanionState {
	focusedAgentSlug: string | null;
	currentPage: number;
}

const DEFAULT_STATE: CompanionState = {
	focusedAgentSlug: null,
	currentPage: 0,
};

const SAVE_DEBOUNCE_MS = 400;

function getStatePath(): string {
	return path.join(homedir(), ".superagent-deck-companion", "state.json");
}

export async function loadState(): Promise<CompanionState> {
	try {
		const raw = await readFile(getStatePath(), "utf8");
		const parsed = JSON.parse(raw) as Partial<CompanionState>;
		return {
			focusedAgentSlug: parsed.focusedAgentSlug ?? null,
			currentPage: typeof parsed.currentPage === "number" ? parsed.currentPage : 0,
		};
	} catch {
		return { ...DEFAULT_STATE };
	}
}

/**
 * Debounced writer — we call this on every page/focus change but only hit
 * disk after the user settles. Avoids thrashing when the user swipes rapidly.
 */
export class StateStore {
	private current: CompanionState = { ...DEFAULT_STATE };
	private saveTimer: ReturnType<typeof setTimeout> | null = null;

	async init(): Promise<void> {
		this.current = await loadState();
	}

	get state(): CompanionState {
		return this.current;
	}

	update(patch: Partial<CompanionState>): void {
		let changed = false;
		for (const key of Object.keys(patch) as (keyof CompanionState)[]) {
			const next = patch[key];
			if (next === undefined) continue;
			if (this.current[key] !== next) {
				(this.current[key] as CompanionState[keyof CompanionState]) = next as never;
				changed = true;
			}
		}
		if (changed) this.scheduleSave();
	}

	async flush(): Promise<void> {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		await this.writeNow();
	}

	private scheduleSave(): void {
		if (this.saveTimer) clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			void this.writeNow();
		}, SAVE_DEBOUNCE_MS);
	}

	private async writeNow(): Promise<void> {
		try {
			const target = getStatePath();
			await mkdir(path.dirname(target), { recursive: true });
			await writeFile(target, JSON.stringify(this.current, null, 2), "utf8");
		} catch (error) {
			console.warn(`[State] Failed to persist state: ${(error as Error).message}`);
		}
	}
}
