import { cp, copyFile, chmod, mkdir, rm, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const distDir = path.join(projectRoot, "dist");
const bundleDir = path.join(projectRoot, "bundle");

const APP_NAME = "SuperAgent Stream Deck Companion";
const BUNDLE_ID = "com.skillfulagents.deck-companion";
const APP_VERSION = "1.0.0";

const targetConfigs = {
	macos: {
		hostPlatform: "darwin",
		build: buildMacOsBundle,
	},
	windows: {
		hostPlatform: "win32",
		build: buildWindowsBundle,
	},
};

function getRequestedTargets() {
	const requested = process.argv.slice(2);
	if (requested.length === 0) {
		throw new Error("Specify at least one target: macos or windows");
	}
	for (const target of requested) {
		if (!(target in targetConfigs)) {
			throw new Error(`Unsupported target "${target}". Expected one of: ${Object.keys(targetConfigs).join(", ")}`);
		}
	}
	return requested;
}

function ensureHostMatchesTarget(target) {
	const config = targetConfigs[target];
	if (process.platform !== config.hostPlatform) {
		throw new Error(
			`Target "${target}" must be built on ${config.hostPlatform}. ` +
			"This bundle includes native dependencies and a bundled Node runtime.",
		);
	}
}

async function ensureBuildOutput() {
	try {
		await access(path.join(distDir, "index.js"));
	} catch {
		throw new Error("Missing dist/index.js. Run `npm run build` before bundling.");
	}
}

function runNpmCiProduction(appDir) {
	const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
	execFileSync(
		npmCommand,
		["ci", "--omit=dev", "--no-audit", "--no-fund"],
		{ cwd: appDir, stdio: "inherit" },
	);
}

async function populateAppPayload(appDir) {
	await cp(distDir, path.join(appDir, "dist"), { recursive: true });
	await copyFile(path.join(projectRoot, "package.json"), path.join(appDir, "package.json"));
	await copyFile(path.join(projectRoot, "package-lock.json"), path.join(appDir, "package-lock.json"));
	runNpmCiProduction(appDir);
}

function defaultConfigJson() {
	return `${JSON.stringify({
		protocol: "superagent",
		portRangeStart: 47891,
		portRangeEnd: 47990,
	}, null, 2)}\n`;
}

// ============================================================================
// macOS: proper .app bundle + sibling helper scripts
// ============================================================================

async function buildMacOsBundle() {
	const targetRoot = path.join(bundleDir, "macos");
	const appBundle = path.join(targetRoot, `${APP_NAME}.app`);
	const contentsDir = path.join(appBundle, "Contents");
	const macOsDir = path.join(contentsDir, "MacOS");
	const resourcesDir = path.join(contentsDir, "Resources");
	const appPayload = path.join(resourcesDir, "app");
	const runtimeBin = path.join(resourcesDir, "runtime", "bin", "node");

	console.log(`\n[Bundle] Preparing macOS .app bundle at ${appBundle}`);
	await rm(targetRoot, { recursive: true, force: true });
	await mkdir(macOsDir, { recursive: true });
	await mkdir(appPayload, { recursive: true });
	await mkdir(path.dirname(runtimeBin), { recursive: true });

	// Payload + native deps
	await populateAppPayload(appPayload);

	// Bundled Node runtime (host arch only). Users on a different arch must
	// rebuild. This keeps us dependency-free on nodejs.org downloads.
	await copyFile(process.execPath, runtimeBin);
	await chmod(runtimeBin, 0o755);

	// Default config template — lives next to the payload so config.ts finds
	// it via appRoot lookup.
	await writeFile(path.join(appPayload, "companion.config.json"), defaultConfigJson(), "utf8");

	// Info.plist — LSUIElement keeps the app out of the Dock / Cmd-Tab so it
	// really behaves like a background companion.
	const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>en</string>
	<key>CFBundleDisplayName</key>
	<string>${APP_NAME}</string>
	<key>CFBundleExecutable</key>
	<string>launcher</string>
	<key>CFBundleIdentifier</key>
	<string>${BUNDLE_ID}</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>${APP_NAME}</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>${APP_VERSION}</string>
	<key>CFBundleVersion</key>
	<string>${APP_VERSION}</string>
	<key>LSMinimumSystemVersion</key>
	<string>11.0</string>
	<key>LSUIElement</key>
	<true/>
	<key>NSHighResolutionCapable</key>
	<true/>
</dict>
</plist>
`;
	await writeFile(path.join(contentsDir, "Info.plist"), infoPlist, "utf8");
	await writeFile(path.join(contentsDir, "PkgInfo"), "APPL????", "utf8");

	// Launcher. Redirects output to ~/Library/Logs/... and shows a native
	// dialog on non-zero exit so a silent background app still surfaces
	// errors (device busy, missing SuperAgent, etc.).
	const launcher = `#!/bin/bash
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RESOURCES="$SCRIPT_DIR/../Resources"
LOG_DIR="$HOME/Library/Logs/SuperAgent-Deck-Companion"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/last-run.log"

# Prevent multiple launches: if a previous PID is still alive, bail.
PID_FILE="$LOG_DIR/companion.pid"
if [ -f "$PID_FILE" ]; then
    OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
        osascript -e 'display alert "SuperAgent Stream Deck Companion is already running." as informational' >/dev/null 2>&1 || true
        exit 0
    fi
fi

cd "$RESOURCES"
"$RESOURCES/runtime/bin/node" "$RESOURCES/app/dist/index.js" >"$LOG_FILE" 2>&1 &
APP_PID=$!
echo "$APP_PID" > "$PID_FILE"
wait "$APP_PID"
EXIT_CODE=$?
rm -f "$PID_FILE"

if [ "$EXIT_CODE" -ne 0 ]; then
    TAIL_TEXT="$(tail -n 4 "$LOG_FILE" 2>/dev/null | tr '"' "'" | tr '\\\\' '/')"
    osascript -e "display alert \\"SuperAgent Stream Deck Companion stopped\\" message \\"Exit code $EXIT_CODE. Recent log:\\n\\n$TAIL_TEXT\\n\\nFull log: ~/Library/Logs/SuperAgent-Deck-Companion/last-run.log\\" as critical" >/dev/null 2>&1 || true
fi

exit "$EXIT_CODE"
`;
	const launcherPath = path.join(macOsDir, "launcher");
	await writeFile(launcherPath, launcher, "utf8");
	await chmod(launcherPath, 0o755);

	// Helper: Stop.command — pkills the background companion.
	const stopScript = `#!/bin/bash
PID_FILE="$HOME/Library/Logs/SuperAgent-Deck-Companion/companion.pid"
if [ -f "$PID_FILE" ]; then
    PID="$(cat "$PID_FILE")"
    if kill -0 "$PID" 2>/dev/null; then
        kill "$PID"
        echo "Stopped (pid $PID)."
    else
        echo "No running process."
    fi
    rm -f "$PID_FILE"
else
    pkill -f "SuperAgent Stream Deck Companion" && echo "Stopped." || echo "No running process."
fi
read -r -p "Press Enter to close..."
`;
	const stopPath = path.join(targetRoot, "Stop Companion.command");
	await writeFile(stopPath, stopScript, "utf8");
	await chmod(stopPath, 0o755);

	// Helper: debug launcher with visible Terminal output, for
	// troubleshooting without digging through log files.
	const debugScript = `#!/bin/bash
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RESOURCES="$SCRIPT_DIR/${APP_NAME}.app/Contents/Resources"
cd "$RESOURCES"
"$RESOURCES/runtime/bin/node" "$RESOURCES/app/dist/index.js"
EXIT_CODE=$?
echo
echo "Exited with code $EXIT_CODE."
read -r -p "Press Enter to close..."
`;
	const debugPath = path.join(targetRoot, "Run in Terminal (debug).command");
	await writeFile(debugPath, debugScript, "utf8");
	await chmod(debugPath, 0o755);

	// Quick-start note in the bundle folder.
	const readme = `SuperAgent Stream Deck Companion (macOS)

QUICK START
1. Double-click "${APP_NAME}.app".
   First time, macOS may block the unsigned app. Right-click the app and
   choose "Open", then confirm. After that, double-click works normally.
2. The app runs silently in the background (no Dock icon).
3. To stop it, double-click "Stop Companion.command".
4. To see live logs while troubleshooting, use
   "Run in Terminal (debug).command" instead of the .app.

LOGS
  ~/Library/Logs/SuperAgent-Deck-Companion/last-run.log

CONFIG
  The default config lives inside the .app. Right-click the app,
  "Show Package Contents", then edit
  Contents/Resources/app/companion.config.json.

REQUIREMENTS
  - Close Elgato's official Stream Deck app before running.
  - Start SuperAgent first (this companion connects to its local API).
`;
	await writeFile(path.join(targetRoot, "README.txt"), readme, "utf8");

	console.log(`[Bundle] Ready: ${appBundle}`);
}

// ============================================================================
// Windows: flat directory with .vbs (silent) + .cmd (debug) launchers
// ============================================================================

async function buildWindowsBundle() {
	const targetRoot = path.join(bundleDir, "windows", APP_NAME);
	const appDir = path.join(targetRoot, "app");
	const runtimeDir = path.join(targetRoot, "runtime");
	const nodeExe = path.join(runtimeDir, "node.exe");

	console.log(`\n[Bundle] Preparing Windows bundle at ${targetRoot}`);
	await rm(targetRoot, { recursive: true, force: true });
	await mkdir(appDir, { recursive: true });
	await mkdir(runtimeDir, { recursive: true });

	await populateAppPayload(appDir);
	await copyFile(process.execPath, nodeExe);
	await writeFile(path.join(appDir, "companion.config.json"), defaultConfigJson(), "utf8");

	// Silent launcher via .vbs — no console window flashes on double-click.
	// Writes logs to %LOCALAPPDATA%\SuperAgent-Deck-Companion\last-run.log.
	//
	// Using Chr(34) for literal double quotes keeps escaping readable. The
	// outer "cmd /c " + quoted-command pattern is cmd.exe's required form
	// when the inner command itself contains quoted paths.
	const vbs = `' SuperAgent Stream Deck Companion silent launcher.
Option Explicit

Dim fso, shell, scriptDir, logDir, logFile, q, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
logDir = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\\SuperAgent-Deck-Companion"
If Not fso.FolderExists(logDir) Then fso.CreateFolder(logDir)
logFile = logDir & "\\last-run.log"

q = Chr(34)
cmd = "cmd /c " & q & q & scriptDir & "\\runtime\\node.exe" & q _
    & " " & q & scriptDir & "\\app\\dist\\index.js" & q _
    & " > " & q & logFile & q & " 2>&1" & q
shell.Run cmd, 0, False
`;
	await writeFile(path.join(targetRoot, `Start ${APP_NAME}.vbs`), vbs, "utf8");

	// Stop helper.
	const stopCmd = `@echo off
echo Stopping SuperAgent Stream Deck Companion...
taskkill /FI "WINDOWTITLE eq ${APP_NAME}" /T /F >nul 2>&1
for /f "tokens=2" %%a in ('tasklist /FI "IMAGENAME eq node.exe" /FO LIST ^| find "PID:"') do (
    wmic process where "ProcessId=%%a" get CommandLine 2>nul | find /i "${APP_NAME.toLowerCase()}" >nul && taskkill /PID %%a /F >nul 2>&1
)
echo Done.
pause
`;
	await writeFile(path.join(targetRoot, "Stop Companion.cmd"), stopCmd, "utf8");

	// Debug launcher: visible console, keeps window open on exit.
	const debugCmd = `@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"
title ${APP_NAME} (debug)
"%SCRIPT_DIR%runtime\\node.exe" "%SCRIPT_DIR%app\\dist\\index.js"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
echo Exited with code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%
`;
	await writeFile(path.join(targetRoot, "Run in Terminal (debug).cmd"), debugCmd, "utf8");

	const readme = `SuperAgent Stream Deck Companion (Windows)

QUICK START
1. Double-click "Start ${APP_NAME}.vbs".
   Windows SmartScreen may warn "Windows protected your PC"; click
   "More info" then "Run anyway".
2. The app runs silently (no console window).
3. To stop it, double-click "Stop Companion.cmd".
4. To see live logs while troubleshooting, use
   "Run in Terminal (debug).cmd" instead of the .vbs.

LOGS
  %LOCALAPPDATA%\\SuperAgent-Deck-Companion\\last-run.log

CONFIG
  Edit app\\companion.config.json.

REQUIREMENTS
  - Close Elgato's official Stream Deck app before running.
  - Start SuperAgent first (this companion connects to its local API).
`;
	await writeFile(path.join(targetRoot, "README.txt"), readme, "utf8");

	console.log(`[Bundle] Ready: ${targetRoot}`);
}

// ============================================================================

async function main() {
	const targets = getRequestedTargets();
	await ensureBuildOutput();
	await mkdir(bundleDir, { recursive: true });

	for (const target of targets) {
		ensureHostMatchesTarget(target);
		await targetConfigs[target].build();
	}
}

main().catch((error) => {
	console.error("[Bundle] Failed:", error instanceof Error ? error.message : error);
	process.exit(1);
});
