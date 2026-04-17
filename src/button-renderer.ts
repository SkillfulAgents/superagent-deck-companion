import sharp from "sharp";
import type { AgentInfo, VisualStatus } from "./types.js";
import { gearSvg, idleSvg, moonSvg, alertSvg, browserSvg, computerSvg, compactingSvg, checkSvg } from "./icons/svgs.js";

// ─── SVG rasterization cache (LRU, bounded) ────────────
// Avoid re-running `sharp` for identical SVG strings. Works well because name/
// border/selected/status don't change every frame; only the animated icon does.
const RASTER_CACHE_MAX = 400;
const rasterCache = new Map<string, Buffer>();

async function rasterizeSvg(svg: string, resize?: { width: number; height: number }): Promise<Buffer> {
	const key = resize ? `${svg}::${resize.width}x${resize.height}` : svg;
	const hit = rasterCache.get(key);
	if (hit) {
		rasterCache.delete(key);
		rasterCache.set(key, hit);
		return hit;
	}

	let pipeline = sharp(Buffer.from(svg));
	if (resize) pipeline = pipeline.resize(resize.width, resize.height);
	const buf = await pipeline.png().toBuffer();

	rasterCache.set(key, buf);
	if (rasterCache.size > RASTER_CACHE_MAX) {
		const firstKey = rasterCache.keys().next().value;
		if (firstKey !== undefined) rasterCache.delete(firstKey);
	}
	return buf;
}

interface RGB { r: number; g: number; b: number }

interface StatusTheme {
	accent: RGB;
	bg: RGB;
	icon: (size: number, fill: string, t: number) => string;
	breathe: boolean;
	breatheSpeed: number;
}

const THEMES: Record<VisualStatus, StatusTheme> = {
	working: {
		accent: { r: 0, g: 210, b: 90 },
		bg: { r: 22, g: 27, b: 34 },
		icon: gearSvg,
		breathe: true,
		breatheSpeed: 1.0,
	},
	idle: {
		accent: { r: 60, g: 130, b: 246 },
		bg: { r: 20, g: 24, b: 36 },
		icon: idleSvg,
		breathe: true,
		breatheSpeed: 0.5,
	},
	sleeping: {
		accent: { r: 90, g: 90, b: 110 },
		bg: { r: 12, g: 12, b: 16 },
		icon: moonSvg,
		breathe: false,
		breatheSpeed: 0,
	},
	awaiting_input: {
		accent: { r: 255, g: 170, b: 30 },
		bg: { r: 40, g: 30, b: 10 },
		icon: alertSvg,
		breathe: true,
		breatheSpeed: 2.0,
	},
	browser_use: {
		accent: { r: 32, g: 205, b: 255 },
		bg: { r: 10, g: 28, b: 40 },
		icon: browserSvg,
		breathe: true,
		breatheSpeed: 1.2,
	},
	computer_use: {
		accent: { r: 196, g: 120, b: 255 },
		bg: { r: 28, g: 14, b: 40 },
		icon: computerSvg,
		breathe: true,
		breatheSpeed: 0.9,
	},
	compacting: {
		accent: { r: 255, g: 92, b: 163 },
		bg: { r: 42, g: 14, b: 28 },
		icon: compactingSvg,
		breathe: true,
		breatheSpeed: 1.4,
	},
};

const EMPTY_BG: RGB = { r: 0, g: 0, b: 0 };
const SELECTED_BORDER: RGB = { r: 255, g: 255, b: 255 };

// Animation runs at 10fps; each status has a cycle period:
// working gear: 3s → 30 frames, sleeping zzz: 3s, idle: 4s, awaiting: 1.2s
const ANIM_PERIODS: Record<VisualStatus, number> = {
	working: 3.0,
	idle: 4.0,
	sleeping: 3.0,
	awaiting_input: 1.2,
	browser_use: 3.6,
	computer_use: 3.2,
	compacting: 2.4,
};

/**
 * Render a single animated frame for a button.
 * `animTime` is the global animation clock in seconds (incremented by the caller at 10fps).
 * `completionFlash` is in range [0, 1]: 1 = just finished (full green overlay),
 *   0 = no flash. The caller is responsible for decaying it over time.
 */
export async function renderButtonFrame(
	agent: AgentInfo | null,
	width: number,
	height: number,
	animTime: number,
	selected: boolean,
	completionFlash = 0,
): Promise<Buffer> {
	if (!agent) {
		return sharp({ create: { width, height, channels: 4, background: { ...EMPTY_BG, alpha: 1 } } })
			.raw().toBuffer();
	}

	// Priority rule: awaiting_input always wins over activityDetail.
	// Attention trumps execution context — if the agent needs the user, show it
	// unambiguously even if it was mid browser_use / computer_use / compacting.
	const visualStatus: VisualStatus = agent.activityStatus === "awaiting_input"
		? "awaiting_input"
		: (agent.activityDetail ?? agent.activityStatus);
	const theme = THEMES[visualStatus];
	const period = ANIM_PERIODS[visualStatus];
	const t = (animTime % period) / period;

	const breatheFactor = theme.breathe
		? 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(animTime * Math.PI * 2 * theme.breatheSpeed))
		: 1.0;

	const accent = theme.accent;
	const bgR = Math.round(theme.bg.r + (accent.r - theme.bg.r) * 0.08 * breatheFactor);
	const bgG = Math.round(theme.bg.g + (accent.g - theme.bg.g) * 0.08 * breatheFactor);
	const bgB = Math.round(theme.bg.b + (accent.b - theme.bg.b) * 0.08 * breatheFactor);
	const bg: RGB = { r: bgR, g: bgG, b: bgB };

	const accentHex = rgbHex(accent);

	const iconSize = Math.round(Math.min(width, height) * 0.40);
	const iconSvg = theme.icon(iconSize, accentHex, t);
	const iconBuf = await rasterizeSvg(iconSvg, { width: iconSize, height: iconSize });

	const borderSvg = visualStatus === "awaiting_input"
		? buildAwaitingInputBorder(width, height, accent, animTime, selected)
		: buildStandardBorder(width, height, accent, selected);
	const borderBuf = await rasterizeSvg(borderSvg);

	const name = agent.name.trim();
	const fontSize = Math.max(14, Math.round(height * 0.22));
	const textHeight = fontSize + 8;
	const textLeftInset = Math.max(14, Math.round(width * 0.16));
	const textRightInset = Math.max(10, Math.round(width * 0.11));
	const textSafeWidth = Math.max(1, width - textLeftInset - textRightInset);
	const textColor = rgbHex(lighten(accent, 0.6));
	const textSvg = createButtonTextSvg({
		name,
		width,
		textHeight,
		textLeftInset,
		textSafeWidth,
		fontSize,
		textColor,
		animTime,
	});
	const textBuf = await rasterizeSvg(textSvg);

	const gap = Math.max(3, Math.round(height * 0.04));
	const blockH = iconSize + gap + textHeight;
	const blockTop = Math.round((height - blockH) / 2);
	const iconTop = Math.max(0, blockTop);
	const textTop = iconTop + iconSize + gap;

	const composites = [
		{ input: borderBuf, left: 0, top: 0 },
		{ input: iconBuf, left: Math.round((width - iconSize) / 2), top: iconTop },
		{ input: textBuf, left: 0, top: textTop },
	];

	if (completionFlash > 0) {
		const flashSize = Math.round(Math.min(width, height) * 0.58);
		const flashSvg = checkSvg(flashSize, COMPLETION_HEX, completionFlash);
		const flashBuf = await rasterizeSvg(flashSvg, { width: flashSize, height: flashSize });
		const haloSvg = buildCompletionHalo(width, height, completionFlash);
		const haloBuf = await rasterizeSvg(haloSvg);
		composites.push(
			{ input: haloBuf, left: 0, top: 0 },
			{ input: flashBuf, left: Math.round((width - flashSize) / 2), top: Math.round((height - flashSize) / 2) },
		);
	}

	return sharp({ create: { width, height, channels: 4, background: { ...bg, alpha: 1 } } })
		.composite(composites)
		.raw()
		.toBuffer();
}

const COMPLETION_COLOR: RGB = { r: 80, g: 220, b: 120 };
const COMPLETION_HEX = rgbHex(COMPLETION_COLOR);

function buildCompletionHalo(width: number, height: number, strength: number): string {
	const clamped = Math.max(0, Math.min(1, strength));
	const outerOpacity = (0.40 * clamped).toFixed(2);
	const innerOpacity = (0.95 * clamped).toFixed(2);
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
		<rect x="1.5" y="1.5" width="${width - 3}" height="${height - 3}"
			rx="4.5" ry="4.5" fill="none" stroke="${COMPLETION_HEX}" stroke-width="3"
			opacity="${outerOpacity}"/>
		<rect x="3" y="3" width="${width - 6}" height="${height - 6}"
			rx="3.5" ry="3.5" fill="none" stroke="${COMPLETION_HEX}" stroke-width="4"
			stroke-linejoin="round" opacity="${innerOpacity}"/>
	</svg>`;
}

/**
 * Standard thin accent border.
 * When `selected`, overlays a white highlight ring just inside it.
 */
function buildStandardBorder(width: number, height: number, accent: RGB, selected: boolean): string {
	const bw = 2;
	const inset = 4;
	const accentHex = rgbHex(accent);
	const selectedRect = selected
		? `<rect x="${inset + bw / 2}" y="${inset + bw / 2}"
			width="${width - inset * 2 - bw}" height="${height - inset * 2 - bw}"
			rx="3" ry="3" fill="none" stroke="${rgbHex(SELECTED_BORDER)}" stroke-width="${bw}"/>`
		: "";
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
		<rect x="${inset + bw / 2}" y="${inset + bw / 2}"
			width="${width - inset * 2 - bw}" height="${height - inset * 2 - bw}"
			rx="3" ry="3" fill="none" stroke="${accentHex}" stroke-width="${bw}"/>
		${selectedRect}
	</svg>`;
}

/**
 * High-attention border for `awaiting_input`.
 * Three stacked layers:
 *   1. Soft outer halo — wide, translucent, slow pulse.
 *   2. Solid inner ring — thick, near-opaque, fast pulse.
 *   3. Optional selected white highlight on top (still readable).
 * The pulse is ~2.5 Hz to match the alert icon's bounce/scale rhythm.
 */
function buildAwaitingInputBorder(
	width: number,
	height: number,
	accent: RGB,
	animTime: number,
	selected: boolean,
): string {
	const fastPulse = 0.5 + 0.5 * Math.sin(animTime * Math.PI * 2 * 2.5);
	const slowPulse = 0.5 + 0.5 * Math.sin(animTime * Math.PI * 2 * 1.0);

	const accentHex = rgbHex(accent);
	const haloHex = rgbHex(lighten(accent, 0.15));

	const ringInset = 3;
	const ringWidth = 4;
	const ringOpacity = (0.82 + 0.18 * fastPulse).toFixed(2);

	const halo1Inset = 1;
	const halo1Width = 3;
	const halo1Opacity = (0.22 + 0.18 * slowPulse).toFixed(2);

	const halo2Inset = 2;
	const halo2Width = 2;
	const halo2Opacity = (0.38 + 0.22 * fastPulse).toFixed(2);

	const selectedLayer = selected
		? `<rect x="${ringInset + 2 + 0.5}" y="${ringInset + 2 + 0.5}"
			width="${width - (ringInset + 2) * 2 - 1}" height="${height - (ringInset + 2) * 2 - 1}"
			rx="2.5" ry="2.5" fill="none" stroke="${rgbHex(SELECTED_BORDER)}" stroke-width="1"
			opacity="0.9"/>`
		: "";

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
		<rect x="${halo1Inset + halo1Width / 2}" y="${halo1Inset + halo1Width / 2}"
			width="${width - halo1Inset * 2 - halo1Width}" height="${height - halo1Inset * 2 - halo1Width}"
			rx="4.5" ry="4.5" fill="none" stroke="${haloHex}" stroke-width="${halo1Width}"
			opacity="${halo1Opacity}"/>
		<rect x="${halo2Inset + halo2Width / 2}" y="${halo2Inset + halo2Width / 2}"
			width="${width - halo2Inset * 2 - halo2Width}" height="${height - halo2Inset * 2 - halo2Width}"
			rx="4" ry="4" fill="none" stroke="${haloHex}" stroke-width="${halo2Width}"
			opacity="${halo2Opacity}"/>
		<rect x="${ringInset + ringWidth / 2}" y="${ringInset + ringWidth / 2}"
			width="${width - ringInset * 2 - ringWidth}" height="${height - ringInset * 2 - ringWidth}"
			rx="3.5" ry="3.5" fill="none" stroke="${accentHex}" stroke-width="${ringWidth}"
			stroke-linejoin="round" opacity="${ringOpacity}"/>
		${selectedLayer}
	</svg>`;
}

function rgbHex(c: RGB): string {
	return `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`;
}

function hex(n: number): string {
	return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
}

function lighten(c: RGB, factor: number): RGB {
	return {
		r: c.r + (255 - c.r) * factor,
		g: c.g + (255 - c.g) * factor,
		b: c.b + (255 - c.b) * factor,
	};
}

function createButtonTextSvg(options: {
	name: string;
	width: number;
	textHeight: number;
	textLeftInset: number;
	textSafeWidth: number;
	fontSize: number;
	textColor: string;
	animTime: number;
}): string {
	const {
		name,
		width,
		textHeight,
		textLeftInset,
		textSafeWidth,
		fontSize,
		textColor,
		animTime,
	} = options;

	const displayName = name || "Agent";
	const textPadding = Math.max(2, Math.round(fontSize * 0.15));
	const textY = fontSize + 2;
	const estimatedWidth = estimateTextWidth(displayName, fontSize);
	const overflow = Math.max(0, estimatedWidth - textSafeWidth);
	const clipId = `button-text-clip-${simpleHash(displayName)}-${width}-${textHeight}-${fontSize}`;

	if (overflow <= 0) {
		return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${textHeight}">
			<text x="${textLeftInset + textSafeWidth / 2}" y="${textY}" text-anchor="middle"
				font-family="Inter, sans-serif" font-size="${fontSize}" font-weight="700"
				fill="${textColor}">${escapeXml(displayName)}</text>
		</svg>`;
	}

	const startX = textLeftInset + textPadding;
	const scrollX = startX - overflow * marqueeProgress(animTime);

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${textHeight}">
		<defs>
			<clipPath id="${clipId}">
				<rect x="${textLeftInset}" y="0" width="${textSafeWidth}" height="${textHeight}"/>
			</clipPath>
		</defs>
		<g clip-path="url(#${clipId})">
			<text x="${scrollX}" y="${textY}" text-anchor="start"
				font-family="Inter, sans-serif" font-size="${fontSize}" font-weight="700"
				fill="${textColor}">${escapeXml(displayName)}</text>
		</g>
	</svg>`;
}

function marqueeProgress(animTime: number): number {
	const holdAtStart = 0.18;
	const moveForward = 0.32;
	const holdAtEnd = 0.18;
	const moveBackward = 0.32;
	const cycle = holdAtStart + moveForward + holdAtEnd + moveBackward;
	const phase = ((animTime * 0.22) % cycle + cycle) % cycle;

	if (phase < holdAtStart) return 0;
	if (phase < holdAtStart + moveForward) {
		return (phase - holdAtStart) / moveForward;
	}
	if (phase < holdAtStart + moveForward + holdAtEnd) return 1;
	return 1 - (phase - holdAtStart - moveForward - holdAtEnd) / moveBackward;
}

/**
 * Per-character width ratios (of fontSize) for Inter 700.
 * Values are approximations based on typical glyph advance widths; good
 * enough to get marquee-vs-static decisions right without shelling out to
 * a real font rasterizer.
 *
 * Anything not listed (CJK, emoji, symbols) falls back to `1.0` which is
 * intentionally conservative so unusual names tend to marquee rather than
 * being silently clipped.
 */
const CHAR_WIDTH_RATIOS: Record<string, number> = {
	" ": 0.28, "!": 0.28, "\"": 0.38, "'": 0.22, "(": 0.32, ")": 0.32,
	",": 0.28, "-": 0.35, ".": 0.28, "/": 0.45, ":": 0.28, ";": 0.28,
	"|": 0.28, "_": 0.50, "+": 0.58, "=": 0.58, "*": 0.42, "&": 0.68,
	"0": 0.58, "1": 0.52, "2": 0.58, "3": 0.58, "4": 0.58, "5": 0.58,
	"6": 0.58, "7": 0.58, "8": 0.58, "9": 0.58,
	a: 0.55, b: 0.58, c: 0.50, d: 0.58, e: 0.53, f: 0.35, g: 0.58,
	h: 0.58, i: 0.28, j: 0.28, k: 0.53, l: 0.28, m: 0.86, n: 0.58,
	o: 0.58, p: 0.58, q: 0.58, r: 0.40, s: 0.50, t: 0.37, u: 0.58,
	v: 0.52, w: 0.78, x: 0.52, y: 0.52, z: 0.50,
	A: 0.64, B: 0.64, C: 0.66, D: 0.68, E: 0.60, F: 0.57, G: 0.69,
	H: 0.70, I: 0.32, J: 0.53, K: 0.65, L: 0.55, M: 0.80, N: 0.72,
	O: 0.71, P: 0.60, Q: 0.74, R: 0.64, S: 0.61, T: 0.62, U: 0.68,
	V: 0.62, W: 0.90, X: 0.61, Y: 0.61, Z: 0.60,
};

function estimateTextWidth(text: string, fontSize: number): number {
	let width = 0;
	for (const char of text) {
		const ratio = CHAR_WIDTH_RATIOS[char] ?? 1.0;
		width += fontSize * ratio;
	}
	return width;
}

function simpleHash(text: string): string {
	let hash = 0;
	for (let i = 0; i < text.length; i += 1) {
		hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
	}
	return hash.toString(16);
}

function escapeXml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// ─── Empty-state card (shown when no agents are registered) ─────

/**
 * Renders a subtle "No agents" card for the first button slot when the
 * companion has no agents to display. Keeps the device from looking broken
 * when SuperAgent is running but empty.
 */
export async function renderEmptyStateCard(
	width: number,
	height: number,
	animTime: number,
): Promise<Buffer> {
	const bg: RGB = { r: 14, g: 16, b: 22 };
	const accent: RGB = { r: 120, g: 140, b: 180 };
	const pulse = 0.55 + 0.25 * (0.5 + 0.5 * Math.sin(animTime * Math.PI * 2 * 0.4));

	const borderSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
		<rect x="4" y="4" width="${width - 8}" height="${height - 8}"
			rx="3" ry="3" fill="none" stroke="${rgbHex(accent)}" stroke-width="1.5"
			stroke-dasharray="4 3" opacity="${pulse.toFixed(2)}"/>
	</svg>`;
	const borderBuf = await rasterizeSvg(borderSvg);

	const titleFont = Math.max(14, Math.round(height * 0.14));
	const bodyFont = Math.max(11, Math.round(height * 0.10));
	const titleColor = rgbHex(lighten(accent, 0.55));
	const bodyColor = rgbHex(lighten(accent, 0.25));

	const textSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
		<text x="${width / 2}" y="${Math.round(height * 0.44)}" text-anchor="middle"
			font-family="Inter, sans-serif" font-size="${titleFont}" font-weight="700"
			fill="${titleColor}">No agents</text>
		<text x="${width / 2}" y="${Math.round(height * 0.58)}" text-anchor="middle"
			font-family="Inter, sans-serif" font-size="${bodyFont}" font-weight="500"
			fill="${bodyColor}">Open SuperAgent</text>
		<text x="${width / 2}" y="${Math.round(height * 0.70)}" text-anchor="middle"
			font-family="Inter, sans-serif" font-size="${bodyFont}" font-weight="500"
			fill="${bodyColor}">to create one</text>
	</svg>`;
	const textBuf = await rasterizeSvg(textSvg);

	return sharp({ create: { width, height, channels: 4, background: { ...bg, alpha: 1 } } })
		.composite([
			{ input: borderBuf, left: 0, top: 0 },
			{ input: textBuf, left: 0, top: 0 },
		])
		.raw()
		.toBuffer();
}

// ─── Sparkline for LCD bar ───────────────────────────────

const LCD_BG: RGB = { r: 8, g: 8, b: 12 };


export async function renderSparkline(
	viewWidth: number,
	height: number,
	agentName: string,
	series: { date: string; tokens: number }[],
): Promise<Buffer> {
	const bgHex = rgbHex(LCD_BG);
	const lineColor = "#5090ff";
	const fillColor = "rgba(80,144,255,0.2)";
	const dotColor = "#80b0ff";
	const labelColor = "#808a98";
	const valueColor = "#e8eef6";

	const padL = 8;
	const padR = 8;
	const padT = 16;
	const padB = 6;
	const chartW = viewWidth - padL - padR;
	const chartH = height - padT - padB;

	const values = series.map((s) => s.tokens);
	const maxVal = Math.max(...values, 1);
	const todayVal = values.length > 0 ? values[values.length - 1] : 0;

	const points = values.map((v, i) => {
		const x = padL + (values.length > 1 ? (i / (values.length - 1)) * chartW : chartW / 2);
		const y = padT + chartH - (v / maxVal) * chartH;
		return { x, y };
	});

	const polyline = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

	const fillPoints = [
		`${padL},${padT + chartH}`,
		...points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`),
		`${padL + chartW},${padT + chartH}`,
	].join(" ");

	const fmtTokens = todayVal >= 1_000_000
		? `${(todayVal / 1_000_000).toFixed(1)}M`
		: todayVal >= 1_000
			? `${(todayVal / 1_000).toFixed(1)}K`
			: String(todayVal);

	const titleFontSize = Math.round(height * 0.19);

	const dots = points.map((p) =>
		`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2" fill="${dotColor}"/>`
	).join("");

	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${viewWidth}" height="${height}">
		<rect width="${viewWidth}" height="${height}" fill="${bgHex}"/>
		<text x="${padL}" y="${titleFontSize}"
			font-family="Inter, sans-serif" font-size="${titleFontSize}" font-weight="600" letter-spacing="0.5"
			fill="${labelColor}">${escapeXml(agentName)}</text>
		<text x="${viewWidth - padR}" y="${titleFontSize}"
			text-anchor="end" font-family="Inter, sans-serif" font-size="${titleFontSize}" font-weight="700"
			fill="${valueColor}">${fmtTokens}</text>
		<polygon points="${fillPoints}" fill="${fillColor}"/>
		<polyline points="${polyline}" fill="none" stroke="${lineColor}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
		${dots}
	</svg>`;

	return sharp(Buffer.from(svg)).resize(viewWidth, height).raw().toBuffer();
}

// ─── Page indicator for RGB buttons ─────────────────────

export function getPageButtonColor(
	side: "left" | "right",
	page: number,
	totalPages: number,
): RGB {
	if (totalPages <= 1) return { r: 8, g: 8, b: 12 };
	if (side === "left") {
		return page > 0 ? { r: 200, g: 120, b: 255 } : { r: 20, g: 12, b: 28 };
	}
	return page < totalPages - 1 ? { r: 200, g: 120, b: 255 } : { r: 20, g: 12, b: 28 };
}
