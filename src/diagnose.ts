import { listStreamDecks, openStreamDeck } from "@elgato-stream-deck/node";

async function main() {
	const devices = await listStreamDecks();
	console.log(`Found ${devices.length} device(s)`);
	if (devices.length === 0) return;

	const deck = await openStreamDeck(devices[0].path);
	console.log(`\nProduct: ${deck.PRODUCT_NAME}`);
	console.log(`Model: ${deck.MODEL}`);
	console.log(`\nAll CONTROLS (${deck.CONTROLS.length}):\n`);

	for (const c of deck.CONTROLS) {
		console.log(JSON.stringify(c, null, 2));
		console.log("---");
	}

	deck.on("down", (control) => {
		console.log(`[DOWN] type=${control.type} index=${"index" in control ? control.index : "N/A"}`);
	});
	deck.on("up", (control) => {
		console.log(`[UP]   type=${control.type} index=${"index" in control ? control.index : "N/A"}`);
	});
	deck.on("lcdShortPress", (_control, pos) => {
		console.log(`[LCD SHORT PRESS] x=${pos.x} y=${pos.y}`);
	});
	deck.on("lcdLongPress", (_control, pos) => {
		console.log(`[LCD LONG PRESS] x=${pos.x} y=${pos.y}`);
	});
	deck.on("lcdSwipe", (_control, from, to) => {
		console.log(`[LCD SWIPE] from=(${from.x},${from.y}) to=(${to.x},${to.y})`);
	});

	console.log("\nListening for events... Press Ctrl+C to exit.\n");

	process.on("SIGINT", async () => {
		await deck.close();
		process.exit(0);
	});
}

main().catch(console.error);
