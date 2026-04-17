import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CompanionError, ExitCode } from "./errors.js";

const DEFAULT_API_PORT = 47891;
const DEFAULT_PORT_SCAN_LIMIT = 99;
const DEFAULT_PROTOCOL = "superagent";
// Single-shot probe timeout. We use a longer value when the user gave us an
// explicit URL/port (they probably want to wait), and a much shorter value
// for the blind port scan (localhost ECONNREFUSED is instant anyway).
const EXPLICIT_PROBE_TIMEOUT_MS = 1200;
const SCAN_PROBE_TIMEOUT_MS = 400;

interface CompanionConfigFile {
	apiBaseUrl?: string;
	apiPort?: number;
	protocol?: string;
	portRangeStart?: number;
	portRangeEnd?: number;
}

export interface RuntimeConfig {
	apiBaseUrl: string;
	apiPort: number;
	protocol: string;
	configPath: string | null;
	appRoot: string;
}

function getAppRoot(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function normalizeApiBaseUrl(raw: string): string {
	try {
		const url = new URL(raw);
		return url.toString().replace(/\/$/, "");
	} catch (error) {
		throw new CompanionError(
			"INVALID_CONFIG",
			`Invalid SUPERAGENT API base URL: ${raw}`,
			ExitCode.InvalidConfig,
			{ cause: error },
		);
	}
}

function resolvePortFromUrl(apiBaseUrl: string): number {
	const url = new URL(apiBaseUrl);
	if (url.port) return parseInt(url.port, 10);
	return url.protocol === "https:" ? 443 : 80;
}

async function readConfigFile(appRoot: string): Promise<{
	config: CompanionConfigFile;
	configPath: string | null;
}> {
	const candidates = Array.from(
		new Set([
			path.join(process.cwd(), "companion.config.json"),
			path.join(appRoot, "companion.config.json"),
		]),
	);

	for (const candidate of candidates) {
		try {
			await access(candidate);
			const raw = await readFile(candidate, "utf8");
			return {
				config: JSON.parse(raw) as CompanionConfigFile,
				configPath: candidate,
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw new CompanionError(
				"INVALID_CONFIG",
				`Unable to read config file: ${candidate}`,
				ExitCode.InvalidConfig,
				{ cause: error },
			);
		}
	}

	return { config: {}, configPath: null };
}

async function probeApiBaseUrl(apiBaseUrl: string, timeoutMs = EXPLICIT_PROBE_TIMEOUT_MS): Promise<boolean> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const response = await fetch(`${apiBaseUrl}/api/agents`, {
			signal: controller.signal,
			headers: { Accept: "application/json" },
		});
		if (!response.ok) return false;

		const data = await response.json();
		return Array.isArray(data);
	} catch {
		return false;
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * Probes a whole port range in parallel. Returns the first base URL whose
 * probe succeeds (via `Promise.any`), or `null` if every port failed. This
 * takes ~400ms worst case instead of ~120s for a 100-port range.
 */
async function scanPortsInParallel(portStart: number, portEnd: number): Promise<string | null> {
	const probes: Promise<string>[] = [];
	for (let port = portStart; port <= portEnd; port += 1) {
		const apiBaseUrl = `http://127.0.0.1:${port}`;
		probes.push(
			probeApiBaseUrl(apiBaseUrl, SCAN_PROBE_TIMEOUT_MS).then((ok) => {
				if (!ok) throw new Error("probe_failed");
				return apiBaseUrl;
			}),
		);
	}

	try {
		return await Promise.any(probes);
	} catch {
		return null;
	}
}

async function resolveApiBaseUrl(config: CompanionConfigFile): Promise<string> {
	const envApiBaseUrl = process.env.SUPERAGENT_API_BASE_URL?.trim();
	if (envApiBaseUrl) {
		const apiBaseUrl = normalizeApiBaseUrl(envApiBaseUrl);
		if (await probeApiBaseUrl(apiBaseUrl)) return apiBaseUrl;
		throw new CompanionError(
			"SUPERAGENT_UNAVAILABLE",
			`Unable to reach the specified SuperAgent API: ${apiBaseUrl}`,
			ExitCode.SuperAgentUnavailable,
		);
	}

	const configuredPort = process.env.SUPERAGENT_PORT ?? config.apiPort?.toString();
	if (configuredPort) {
		const port = parseInt(configuredPort, 10);
		if (!Number.isInteger(port) || port <= 0) {
			throw new CompanionError(
				"INVALID_CONFIG",
				`Invalid SUPERAGENT_PORT value: ${configuredPort}`,
				ExitCode.InvalidConfig,
			);
		}

		const apiBaseUrl = `http://127.0.0.1:${port}`;
		if (await probeApiBaseUrl(apiBaseUrl)) return apiBaseUrl;
		throw new CompanionError(
			"SUPERAGENT_UNAVAILABLE",
			`Unable to reach SuperAgent on the specified port: ${port}`,
			ExitCode.SuperAgentUnavailable,
		);
	}

	if (config.apiBaseUrl) {
		const apiBaseUrl = normalizeApiBaseUrl(config.apiBaseUrl);
		if (await probeApiBaseUrl(apiBaseUrl)) return apiBaseUrl;
		throw new CompanionError(
			"SUPERAGENT_UNAVAILABLE",
			`Unable to reach the SuperAgent API from config: ${apiBaseUrl}`,
			ExitCode.SuperAgentUnavailable,
		);
	}

	const portRangeStart = config.portRangeStart ?? DEFAULT_API_PORT;
	const portRangeEnd = config.portRangeEnd ?? DEFAULT_API_PORT + DEFAULT_PORT_SCAN_LIMIT;

	const found = await scanPortsInParallel(portRangeStart, portRangeEnd);
	if (found) return found;

	throw new CompanionError(
		"SUPERAGENT_UNAVAILABLE",
		`Unable to find a reachable SuperAgent instance. Start SuperAgent first. Scanned ports ${portRangeStart}-${portRangeEnd}.`,
		ExitCode.SuperAgentUnavailable,
	);
}

export async function resolveRuntimeConfig(): Promise<RuntimeConfig> {
	const appRoot = getAppRoot();
	const { config, configPath } = await readConfigFile(appRoot);
	const apiBaseUrl = await resolveApiBaseUrl(config);
	const protocol = process.env.SUPERAGENT_PROTOCOL?.trim() || config.protocol || DEFAULT_PROTOCOL;

	return {
		apiBaseUrl,
		apiPort: resolvePortFromUrl(apiBaseUrl),
		protocol,
		configPath,
		appRoot,
	};
}
