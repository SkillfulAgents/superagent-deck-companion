import { cp, copyFile, chmod, mkdir, rm, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const distDir = path.join(projectRoot, "dist");
const bundleDir = path.join(projectRoot, "bundle");

const targetConfigs = {
	macos: {
		hostPlatform: "darwin",
		runtimeRelativePath: path.join("runtime", "bin", "node"),
		launcherFiles: [
			{
				name: "Start SuperAgent Stream Deck.command",
				mode: 0o755,
				content: `#!/bin/bash
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$SCRIPT_DIR/logs"
cd "$SCRIPT_DIR"
"$SCRIPT_DIR/runtime/bin/node" "$SCRIPT_DIR/app/dist/index.js" 2>&1 | tee "$SCRIPT_DIR/logs/last-run.log"
EXIT_CODE=\${PIPESTATUS[0]}
echo
if [ "$EXIT_CODE" -ne 0 ]; then
  echo "SuperAgent Stream Deck Companion exited with code $EXIT_CODE."
fi
read -r -p "Press Enter to close..."
exit "$EXIT_CODE"
`,
			},
		],
	},
	windows: {
		hostPlatform: "win32",
		runtimeRelativePath: path.join("runtime", "node.exe"),
		launcherFiles: [
			{
				name: "Start SuperAgent Stream Deck.cmd",
				content: `@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"
"%SCRIPT_DIR%runtime\\node.exe" "%SCRIPT_DIR%app\\dist\\index.js"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%EXIT_CODE%"=="0" echo SuperAgent Stream Deck Companion exited with code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%
`,
			},
		],
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
		{
			cwd: appDir,
			stdio: "inherit",
		},
	);
}

async function writeLaunchers(targetRoot, targetConfig) {
	for (const launcher of targetConfig.launcherFiles) {
		const launcherPath = path.join(targetRoot, launcher.name);
		await writeFile(launcherPath, launcher.content, "utf8");
		if (launcher.mode) {
			await chmod(launcherPath, launcher.mode);
		}
	}
}

async function ensureConfigTemplate(targetRoot) {
	const configPath = path.join(targetRoot, "companion.config.json");
	const template = {
		protocol: "superagent",
		portRangeStart: 47891,
		portRangeEnd: 47990,
	};

	await writeFile(configPath, `${JSON.stringify(template, null, 2)}\n`, "utf8");
}

async function buildTarget(target) {
	ensureHostMatchesTarget(target);

	const targetConfig = targetConfigs[target];
	const targetRoot = path.join(bundleDir, target, "SuperAgent Stream Deck Companion");
	const appDir = path.join(targetRoot, "app");
	const runtimePath = path.join(targetRoot, targetConfig.runtimeRelativePath);

	console.log(`\n[Bundle] Preparing ${target} bundle...`);
	await rm(targetRoot, { recursive: true, force: true });
	await mkdir(appDir, { recursive: true });
	await mkdir(path.dirname(runtimePath), { recursive: true });
	await mkdir(path.join(targetRoot, "logs"), { recursive: true });

	await cp(distDir, path.join(appDir, "dist"), { recursive: true });
	await copyFile(path.join(projectRoot, "package.json"), path.join(appDir, "package.json"));
	await copyFile(path.join(projectRoot, "package-lock.json"), path.join(appDir, "package-lock.json"));

	runNpmCiProduction(appDir);

	await copyFile(process.execPath, runtimePath);
	if (target === "macos") {
		await chmod(runtimePath, 0o755);
	}

	await ensureConfigTemplate(targetRoot);
	await writeLaunchers(targetRoot, targetConfig);

	console.log(`[Bundle] Ready: ${targetRoot}`);
}

async function main() {
	const targets = getRequestedTargets();
	await ensureBuildOutput();
	await mkdir(bundleDir, { recursive: true });

	for (const target of targets) {
		await buildTarget(target);
	}
}

main().catch((error) => {
	console.error("[Bundle] Failed:", error instanceof Error ? error.message : error);
	process.exit(1);
});
