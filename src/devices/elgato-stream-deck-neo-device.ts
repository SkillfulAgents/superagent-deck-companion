import {
	listStreamDecks,
	openStreamDeck,
} from "@elgato-stream-deck/node";
import type {
	StreamDeckButtonControlDefinitionLcdFeedback,
	StreamDeckButtonControlDefinitionRgbFeedback,
	StreamDeckLcdSegmentControlDefinition,
	StreamDeck,
} from "@elgato-stream-deck/core";
import { CompanionError, ExitCode } from "../errors.js";
import { isOfficialStreamDeckAppRunning } from "../platform-utils.js";
import type {
	ButtonPressHandler,
	ButtonReleaseHandler,
	CompanionDevice,
	DeviceDisconnectHandler,
	DeviceInfo,
	DeviceLcdButton,
	DeviceLcdSegmentInfo,
	LcdSwipeHandler,
} from "./device.js";

const SUPPORTED_MODEL_HINT = "neo";

export class ElgatoStreamDeckNeoDevice implements CompanionDevice {
	private deck: StreamDeck | null = null;
	private deviceInfo: DeviceInfo | null = null;
	private onPress: ButtonPressHandler = () => {};
	private onRelease: ButtonReleaseHandler = () => {};
	private onSwipe: LcdSwipeHandler = () => {};
	private onDisconnect: DeviceDisconnectHandler = () => {};
	private lcdButtons: DeviceLcdButton[] = [];
	private rgbButtonIndices: number[] = [];
	private lcdSegment: DeviceLcdSegmentInfo | null = null;
	private disconnectReported = false;

	async connect(): Promise<void> {
		this.disconnectReported = false;
		const devices = await this.listDevices();
		const target = devices.find((device) =>
			device.model?.toLowerCase().includes(SUPPORTED_MODEL_HINT) ||
			device.productName?.toLowerCase().includes(SUPPORTED_MODEL_HINT),
		) ?? devices[0];

		if (!target) {
			throw new CompanionError(
				"NO_STREAM_DECK",
				"No Stream Deck Neo device detected. Please connect the device and try again.",
				ExitCode.DeckUnavailable,
			);
		}

		console.log(`[Device] Connecting to ${target.productName ?? target.model ?? "Stream Deck Neo"} (${target.serialNumber})`);

		try {
			this.deck = await openStreamDeck(target.path);
		} catch (error) {
			const officialAppRunning = await isOfficialStreamDeckAppRunning();
			const details = officialAppRunning
				? "The official Elgato Stream Deck app appears to be using the device. Please close it and try again."
				: "The device may already be in use by another app, or this process may not have permission to access it.";
			throw new CompanionError(
				"DECK_BUSY",
				`Unable to connect to the Stream Deck Neo. ${details}`,
				ExitCode.DeckUnavailable,
				{ cause: error },
			);
		}

		await this.deck.setBrightness(80);
		this.deviceInfo = {
			modelName: this.deck.MODEL ?? "Stream Deck Neo",
			productName: this.deck.PRODUCT_NAME,
		};
		this.initializeControls(this.deck);
		this.registerInputHandlers(this.deck);

		console.log(`[Device] Connected: ${this.deviceInfo.productName} (${this.lcdButtons.length} LCD, ${this.rgbButtonIndices.length} RGB, ${this.lcdSegment ? "1 LCD bar" : "no LCD bar"})`);
	}

	async close(): Promise<void> {
		if (!this.deck) return;
		try {
			await this.deck.clearPanel();
			await this.deck.close();
		} catch {
			// Device may already be gone; ignore so shutdown can proceed.
		}
		this.deck = null;
		this.deviceInfo = null;
	}

	async clearAll(): Promise<void> {
		if (!this.deck) return;
		await this.deck.clearPanel();
	}

	getDeviceInfo(): DeviceInfo | null {
		return this.deviceInfo;
	}

	getLcdButtons(): DeviceLcdButton[] {
		return this.lcdButtons;
	}

	getRgbButtonIndices(): number[] {
		return this.rgbButtonIndices;
	}

	getLcdSegment(): DeviceLcdSegmentInfo | null {
		return this.lcdSegment;
	}

	async fillLcdButton(index: number, rgbaBuf: Buffer): Promise<void> {
		if (!this.deck) return;
		try {
			await this.deck.fillKeyBuffer(index, rgbaBuf, { format: "rgba" });
		} catch (error) {
			this.handleDisconnection(error);
		}
	}

	async fillRgbButton(index: number, r: number, g: number, b: number): Promise<void> {
		if (!this.deck) return;
		try {
			await this.deck.fillKeyColor(index, r, g, b);
		} catch (error) {
			this.handleDisconnection(error);
		}
	}

	async fillLcdBar(imageBuffer: Buffer): Promise<void> {
		if (!this.deck || !this.lcdSegment) return;
		try {
			await this.deck.fillLcd(this.lcdSegment.id, imageBuffer, { format: "rgba" });
		} catch (error) {
			this.handleDisconnection(error);
		}
	}

	setOnPress(handler: ButtonPressHandler): void {
		this.onPress = handler;
	}

	setOnRelease(handler: ButtonReleaseHandler): void {
		this.onRelease = handler;
	}

	setOnSwipe(handler: LcdSwipeHandler): void {
		this.onSwipe = handler;
	}

	setOnDisconnect(handler: DeviceDisconnectHandler): void {
		this.onDisconnect = handler;
	}

	/**
	 * Called when the HID layer reports an error or a write fails unexpectedly —
	 * usually because the device was unplugged. Fires onDisconnect at most once
	 * per connect cycle so the app can trigger a reconnect loop.
	 */
	private handleDisconnection(error: unknown): void {
		if (this.disconnectReported) return;
		this.disconnectReported = true;
		const err = error instanceof Error ? error : new Error(String(error));
		this.deck = null;
		this.deviceInfo = null;
		this.onDisconnect(err);
	}

	private async listDevices() {
		try {
			const devices = await listStreamDecks();
			if (devices.length === 0) return devices;
			return devices;
		} catch (error) {
			throw new CompanionError(
				"DECK_CONNECT_FAILED",
				"Failed to enumerate Stream Deck devices. Please verify USB connectivity and device drivers.",
				ExitCode.DeckUnavailable,
				{ cause: error },
			);
		}
	}

	private initializeControls(deck: StreamDeck): void {
		const controls = deck.CONTROLS;
		const buttons = controls.filter((control) => control.type === "button");

		this.lcdButtons = buttons
			.filter((button): button is StreamDeckButtonControlDefinitionLcdFeedback => button.feedbackType === "lcd")
			.map((button) => ({ index: button.index, width: button.pixelSize.width, height: button.pixelSize.height }));

		this.rgbButtonIndices = buttons
			.filter((button): button is StreamDeckButtonControlDefinitionRgbFeedback => button.feedbackType === "rgb")
			.map((button) => button.index);

		const lcdSegment = controls.find(
			(control): control is StreamDeckLcdSegmentControlDefinition => control.type === "lcd-segment",
		);

		this.lcdSegment = lcdSegment
			? { id: lcdSegment.id, width: lcdSegment.pixelSize.width, height: lcdSegment.pixelSize.height }
			: null;
	}

	private registerInputHandlers(deck: StreamDeck): void {
		deck.on("down", (control) => {
			if (control.type === "button") this.onPress(control.index);
		});

		deck.on("up", (control) => {
			if (control.type === "button") this.onRelease(control.index);
		});

		deck.on("lcdSwipe", (_control, from, to) => {
			this.onSwipe(from, to);
		});

		deck.on("error", (error) => {
			console.error("[Device] Error:", error);
			this.handleDisconnection(error);
		});
	}
}
