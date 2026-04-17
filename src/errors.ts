export enum ExitCode {
	StartupFailure = 1,
	InvalidConfig = 2,
	SuperAgentUnavailable = 3,
	DeckUnavailable = 4,
	NavigationFailure = 5,
}

export type CompanionErrorCode =
	| "INVALID_CONFIG"
	| "SUPERAGENT_UNAVAILABLE"
	| "NO_STREAM_DECK"
	| "DECK_BUSY"
	| "DECK_CONNECT_FAILED"
	| "NAVIGATION_FAILED";

export class CompanionError extends Error {
	public readonly code: CompanionErrorCode;
	public readonly exitCode: ExitCode;
	public readonly details?: string;
	public readonly cause?: unknown;

	constructor(
		code: CompanionErrorCode,
		message: string,
		exitCode: ExitCode,
		options?: { details?: string; cause?: unknown },
	) {
		super(message);
		this.name = "CompanionError";
		this.code = code;
		this.exitCode = exitCode;
		this.details = options?.details;
		this.cause = options?.cause;
	}
}
