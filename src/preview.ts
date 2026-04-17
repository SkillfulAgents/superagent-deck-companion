import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { renderButtonFrame, renderEmptyStateCard } from "./button-renderer.js";
import type { AgentInfo, VisualStatus } from "./types.js";

/**
 * Headless renderer — dumps a grid of all agent states to ./preview/*.png
 * at several animation phases. Lets us iterate on icons / borders / colors
 * without touching hardware.
 *
 * Usage: `npm run preview` (or `npx tsx src/preview.ts`)
 */

const BUTTON_WIDTH = 120;
const BUTTON_HEIGHT = 120;
const PHASES = [0, 0.3, 0.6, 0.9, 1.2, 1.5];

const SCENARIOS: Array<{
	label: string;
	agent: AgentInfo;
	selected?: boolean;
	completionFlash?: number;
}> = [
	{
		label: "working",
		agent: { slug: "w", name: "Alpha", activityStatus: "working" },
	},
	{
		label: "idle",
		agent: { slug: "i", name: "Bravo", activityStatus: "idle" },
	},
	{
		label: "sleeping",
		agent: { slug: "s", name: "Charlie", activityStatus: "sleeping" },
	},
	{
		label: "awaiting_input",
		agent: { slug: "a", name: "Delta", activityStatus: "awaiting_input" },
	},
	{
		label: "awaiting_input+browser (attention wins)",
		agent: { slug: "ab", name: "Echo", activityStatus: "awaiting_input", activityDetail: "browser_use" },
	},
	{
		label: "browser_use",
		agent: { slug: "br", name: "Foxtrot", activityStatus: "working", activityDetail: "browser_use" },
	},
	{
		label: "computer_use",
		agent: { slug: "cu", name: "Golf", activityStatus: "working", activityDetail: "computer_use" },
	},
	{
		label: "compacting",
		agent: { slug: "co", name: "Hotel", activityStatus: "working", activityDetail: "compacting" },
	},
	{
		label: "selected + working",
		agent: { slug: "sel", name: "India", activityStatus: "working" },
		selected: true,
	},
	{
		label: "long name (marquee)",
		agent: { slug: "long", name: "A Very Long Agent Name", activityStatus: "working" },
	},
	{
		label: "Elgato (should fit, narrow l+t)",
		agent: { slug: "elgato", name: "Elgato", activityStatus: "idle" },
	},
	{
		label: "Demos (should fit)",
		agent: { slug: "demos", name: "Demos", activityStatus: "idle" },
	},
	{
		label: "completion flash",
		agent: { slug: "done", name: "Juliet", activityStatus: "idle" },
		completionFlash: 0.9,
	},
];

async function renderGrid(outDir: string): Promise<void> {
	const cellW = BUTTON_WIDTH + 20;
	const cellH = BUTTON_HEIGHT + 46;
	const cols = PHASES.length;
	const rows = SCENARIOS.length;
	const padding = 14;
	const canvasW = padding + cols * cellW + padding;
	const canvasH = padding + rows * cellH + padding + 30;

	const labelRow = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasW}" height="${canvasH}">
		<rect width="${canvasW}" height="${canvasH}" fill="#0b0e14"/>
		${PHASES.map((p, i) => `<text x="${padding + i * cellW + cellW / 2}" y="22"
			text-anchor="middle" font-family="Inter, sans-serif" font-size="14" font-weight="600"
			fill="#8898b0">t = ${p.toFixed(2)}s</text>`).join("")}
		${SCENARIOS.map((s, i) => `<text x="${padding + cols * cellW + 4}" y="${padding + 30 + i * cellH + cellH / 2}"
			dominant-baseline="middle" font-family="Inter, sans-serif" font-size="12" font-weight="500"
			fill="#b8c4d8"></text>`).join("")}
	</svg>`;

	const baseBuf = await sharp(Buffer.from(labelRow)).raw().toBuffer({ resolveWithObject: true });

	const composites: sharp.OverlayOptions[] = [];

	for (let row = 0; row < rows; row += 1) {
		const scenario = SCENARIOS[row];
		for (let col = 0; col < cols; col += 1) {
			const animTime = PHASES[col];
			const buf = await renderButtonFrame(
				scenario.agent,
				BUTTON_WIDTH,
				BUTTON_HEIGHT,
				animTime,
				scenario.selected ?? false,
				scenario.completionFlash ?? 0,
			);
			const pngBuf = await sharp(buf, { raw: { width: BUTTON_WIDTH, height: BUTTON_HEIGHT, channels: 4 } })
				.png().toBuffer();
			composites.push({
				input: pngBuf,
				left: padding + col * cellW + 10,
				top: padding + 30 + row * cellH + 8,
			});
		}

		const labelSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cellW * cols}" height="28">
			<text x="${padding - 4}" y="20" font-family="Inter, sans-serif" font-size="13" font-weight="700"
				fill="#c8d4e8">${scenario.label}</text>
		</svg>`;
		const labelBuf = await sharp(Buffer.from(labelSvg)).png().toBuffer();
		composites.push({
			input: labelBuf,
			left: 2,
			top: padding + 30 + row * cellH + BUTTON_HEIGHT + 14,
		});
	}

	const finalBuf = await sharp(baseBuf.data, {
		raw: { width: canvasW, height: canvasH, channels: 4 },
	})
		.composite(composites)
		.png()
		.toBuffer();

	await mkdir(outDir, { recursive: true });
	const target = path.join(outDir, "grid.png");
	await writeFile(target, finalBuf);
	console.log(`[Preview] Wrote ${target} (${canvasW}x${canvasH})`);
}

async function renderIndividualFrames(outDir: string): Promise<void> {
	const targetDir = path.join(outDir, "frames");
	await mkdir(targetDir, { recursive: true });

	const statuses: VisualStatus[] = [
		"working",
		"idle",
		"sleeping",
		"awaiting_input",
		"browser_use",
		"computer_use",
		"compacting",
	];

	for (const status of statuses) {
		for (const phase of PHASES) {
			const agent: AgentInfo = status === "browser_use" || status === "computer_use" || status === "compacting"
				? { slug: status, name: status, activityStatus: "working", activityDetail: status }
				: { slug: status, name: status, activityStatus: status };
			const buf = await renderButtonFrame(agent, BUTTON_WIDTH, BUTTON_HEIGHT, phase, false, 0);
			const pngBuf = await sharp(buf, { raw: { width: BUTTON_WIDTH, height: BUTTON_HEIGHT, channels: 4 } })
				.png().toBuffer();
			const name = `${status}-t${phase.toFixed(2)}.png`;
			await writeFile(path.join(targetDir, name), pngBuf);
		}
	}

	const emptyBuf = await renderEmptyStateCard(BUTTON_WIDTH, BUTTON_HEIGHT, 0);
	const emptyPng = await sharp(emptyBuf, { raw: { width: BUTTON_WIDTH, height: BUTTON_HEIGHT, channels: 4 } })
		.png().toBuffer();
	await writeFile(path.join(targetDir, "empty-state.png"), emptyPng);

	console.log(`[Preview] Wrote ${statuses.length * PHASES.length + 1} individual frames to ${targetDir}`);
}

async function main(): Promise<void> {
	const outDir = path.resolve(process.cwd(), "preview");
	await renderGrid(outDir);
	await renderIndividualFrames(outDir);
	console.log(`\nDone. Open ${path.join(outDir, "grid.png")} to review.`);
}

main().catch((error) => {
	console.error("[Preview] Failed:", error);
	process.exit(1);
});
