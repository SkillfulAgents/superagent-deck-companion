import { execFile } from "node:child_process";
import { platform } from "node:os";
import { CompanionError, ExitCode } from "./errors.js";

/**
 * Run a command without going through a shell. Passing argv directly to
 * execFile avoids all of the shell-metacharacter escaping pitfalls we'd hit
 * with `exec`, which is important because `scheme` / `path` are sourced from
 * config and could in theory contain odd characters in the future.
 */
function runCommand(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile(command, args, (error, stdout, stderr) => {
			if (error) {
				reject(Object.assign(error, { stdout, stderr }));
				return;
			}
			resolve({ stdout, stderr });
		});
	});
}

/**
 * Detect whether the official Elgato Stream Deck desktop app is running.
 * Matching on "Elgato Stream Deck" (full phrase) avoids false positives from
 * unrelated processes that merely contain the words "Stream Deck" in their
 * command line (e.g. browser tabs, docs windows).
 */
export async function isOfficialStreamDeckAppRunning(): Promise<boolean> {
	try {
		if (platform() === "darwin") {
			const { stdout } = await runCommand("pgrep", ["-f", "Elgato Stream Deck"]);
			return stdout.trim().length > 0;
		}

		if (platform() === "win32") {
			const { stdout } = await runCommand("tasklist", ["/FI", "IMAGENAME eq StreamDeck.exe"]);
			return stdout.includes("StreamDeck.exe");
		}
	} catch {
		return false;
	}

	return false;
}

export async function openDeepLink(path: string, scheme: string): Promise<void> {
	const deepLink = `${scheme}://${path}`;

	try {
		if (platform() === "darwin") {
			await runCommand("open", [deepLink]);
		} else if (platform() === "win32") {
			// `start` is a cmd.exe builtin, so we still need cmd here, but passing
			// the URL as a discrete argv entry keeps shell metacharacters inert.
			// The empty-string second arg is `start`'s conventional "title" slot.
			await runCommand("cmd", ["/c", "start", "", deepLink]);
		} else {
			await runCommand("xdg-open", [deepLink]);
		}
	} catch (error) {
		throw new CompanionError(
			"NAVIGATION_FAILED",
			`Unable to open SuperAgent deep link: ${deepLink}`,
			ExitCode.NavigationFailure,
			{ cause: error },
		);
	}
}
