/**
 * Animated SVG icons for each activity status.
 * Each function accepts size, fill, and an animation parameter `t` (0..1 normalized phase).
 */

export function gearSvg(size: number, fill: string, t = 0): string {
	const angle = Math.round(t * 360);
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">
		<g transform="rotate(${angle}, 12, 12)" fill="${fill}">
			<path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58
			c0.18-0.14,0.23-0.41,0.12-0.61l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96
			c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41h-3.84
			c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33
			c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58
			C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.07,0.94l-2.03,1.58c-0.18,0.14-0.23,0.41-0.12,0.61
			l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94
			l0.36,2.54c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54
			c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32
			c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6
			s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z"/>
		</g>
	</svg>`;
}

export function moonSvg(size: number, fill: string, t = 0): string {
	// 💤 style: three Z's stacked diagonally, rising and fading
	const phase = (offset: number) => (t + offset) % 1;
	const zy = (p: number) => 14 - p * 14;
	const opacity = (p: number) => p < 0.7 ? 1.0 : 1.0 - (p - 0.7) / 0.3;

	const p1 = phase(0);
	const p2 = phase(0.33);
	const p3 = phase(0.66);

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">
		<path fill="${fill}" d="M12.43,2.3c-0.36-0.14-0.77,0.07-0.83,0.45C11.09,6.07,13.52,9.7,16.84,10.81
		c1.47,0.49,3.01,0.49,4.42,0.08c0.38-0.11,0.72,0.27,0.57,0.64
		C20.2,15.24,16.58,18,12.35,18C7.13,18,2.91,13.73,2.91,8.45
		c0-3.37,1.77-6.43,4.62-8.11c0.34-0.2,0.04-0.73-0.33-0.58
		C3.16,1.46,0,5.65,0,10.5C0,16.85,5.15,22,11.5,22
		c5.24,0,9.65-3.52,11.03-8.32c0.13-0.45-0.32-0.86-0.76-0.72
		c-1.68,0.52-3.54,0.43-5.18-0.31c-3.44-1.55-5.26-5.3-4.56-8.96
		C12.12,3.24,12.42,2.74,12.43,2.3z"/>
		<g font-family="Inter, sans-serif" font-weight="900" fill="${fill}" font-style="italic">
			<text x="14" y="${zy(p1).toFixed(1)}" font-size="10" opacity="${opacity(p1).toFixed(2)}">Z</text>
			<text x="17.5" y="${zy(p2).toFixed(1)}" font-size="8" opacity="${opacity(p2).toFixed(2)}">Z</text>
			<text x="20" y="${zy(p3).toFixed(1)}" font-size="6" opacity="${opacity(p3).toFixed(2)}">Z</text>
		</g>
	</svg>`;
}

export function idleSvg(size: number, fill: string, t = 0): string {
	const pulse = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(t * Math.PI * 2));
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">
		<circle cx="12" cy="12" r="8" fill="${fill}" opacity="${pulse.toFixed(3)}"/>
		<circle cx="12" cy="12" r="4" fill="${fill}"/>
	</svg>`;
}

export function alertSvg(size: number, fill: string, t = 0): string {
	const bounce = Math.abs(Math.sin(t * Math.PI * 2)) * 3;
	const scale = 0.85 + 0.15 * Math.abs(Math.sin(t * Math.PI * 2));
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">
		<g transform="translate(12, ${12 - bounce}) scale(${scale.toFixed(3)}) translate(-12, -12)" fill="${fill}">
			<path d="M12,2C6.48,2,2,6.48,2,12s4.48,10,10,10s10-4.48,10-10S17.52,2,12,2z
			M13,17h-2v-2h2V17z M13,13h-2V7h2V13z"/>
		</g>
	</svg>`;
}

export function browserSvg(size: number, fill: string, t = 0): string {
	const angle = Math.round(t * 360);
	const ringTilt = 14 + Math.sin(t * Math.PI * 2) * 3;
	const pulse = 0.78 + 0.16 * (0.5 + 0.5 * Math.sin(t * Math.PI * 2));

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">
		<ellipse cx="12" cy="12" rx="9.3" ry="4.2"
			transform="rotate(${ringTilt.toFixed(2)} 12 12)"
			fill="none" stroke="${fill}" stroke-width="1.55" opacity="${pulse.toFixed(2)}"/>
		<ellipse cx="12" cy="12" rx="9.3" ry="4.2"
			transform="rotate(${(ringTilt + 90).toFixed(2)} 12 12)"
			fill="none" stroke="${fill}" stroke-width="1.05" opacity="0.26"/>
		<g transform="rotate(${angle} 12 12)">
			<path d="M12 3.1l1.25 5.75L19 10l-5.75 1.15L12 16.9l-1.25-5.75L5 10l5.75-1.15L12 3.1z"
				fill="${fill}" opacity="0.97"/>
			<path d="M12 6.55l0.58 2.87L15.45 10l-2.87 0.58L12 13.45l-0.58-2.87L8.55 10l2.87-0.58L12 6.55z"
				fill="#000000" opacity="0.14"/>
			<circle cx="12" cy="10" r="0.72" fill="${fill}" opacity="0.92"/>
		</g>
	</svg>`;
}

export function computerSvg(size: number, fill: string, t = 0): string {
	const sweep = 7 + ((t * 10) % 8);
	const cursorScale = 0.92 + 0.08 * Math.sin(t * Math.PI * 2);

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">
		<rect x="3" y="4" width="18" height="12" rx="2.5" ry="2.5" fill="none" stroke="${fill}" stroke-width="1.7"/>
		<path d="M9 20h6M12 16v4" stroke="${fill}" stroke-width="1.5" stroke-linecap="round"/>
		<path d="M5.2 ${sweep.toFixed(2)}h13.6" stroke="${fill}" stroke-width="1.2" opacity="0.35"/>
		<g transform="translate(15.8,10.7) scale(${cursorScale.toFixed(3)}) translate(-15.8,-10.7)">
			<path d="M13.4 6.4v7.8l2.05-2.1 1.55 3.55 1.55-.65-1.55-3.55 2.95-.2-6.55-4.85z"
				fill="${fill}" opacity="0.95"/>
		</g>
	</svg>`;
}

export function compactingSvg(size: number, fill: string, t = 0): string {
	const leftShift = 3.8 + Math.sin(t * Math.PI * 2) * 1.25;
	const rightShift = 20.2 - Math.sin(t * Math.PI * 2) * 1.25;
	const centerPulse = 0.72 + 0.18 * (0.5 + 0.5 * Math.sin(t * Math.PI * 2));

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">
		<rect x="4" y="5" width="16" height="14" rx="2.5" ry="2.5" fill="none" stroke="${fill}" stroke-width="1.6" opacity="0.35"/>
		<path d="M${leftShift.toFixed(2)} 8.5l3.8 3.5-3.8 3.5" fill="none" stroke="${fill}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
		<path d="M${rightShift.toFixed(2)} 8.5l-3.8 3.5 3.8 3.5" fill="none" stroke="${fill}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
		<rect x="10.1" y="8.1" width="3.8" height="7.8" rx="1.2" fill="${fill}" opacity="${centerPulse.toFixed(2)}"/>
	</svg>`;
}

export function emptySvg(size: number): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24"></svg>`;
}

/**
 * Check mark inside a circle — used for the "agent finished" flash overlay.
 * `t` here is the overall strength (1 = full intensity, 0 = invisible).
 */
export function checkSvg(size: number, fill: string, t = 1): string {
	const strength = Math.max(0, Math.min(1, t));
	const scale = 0.6 + 0.4 * strength;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">
		<g transform="translate(12,12) scale(${scale.toFixed(3)}) translate(-12,-12)" opacity="${strength.toFixed(2)}">
			<circle cx="12" cy="12" r="10" fill="${fill}"/>
			<path d="M7.2 12.4 L10.6 15.8 L16.8 8.6"
				fill="none" stroke="#0b1412" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
		</g>
	</svg>`;
}
