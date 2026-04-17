import type { LcdPosition } from "@elgato-stream-deck/core";

export type ButtonPressHandler = (buttonIndex: number) => void;
export type ButtonReleaseHandler = (buttonIndex: number) => void;
export type LcdSwipeHandler = (from: LcdPosition, to: LcdPosition) => void;
export type DeviceDisconnectHandler = (error: Error) => void;

export interface DeviceLcdButton {
	index: number;
	width: number;
	height: number;
}

export interface DeviceLcdSegmentInfo {
	id: number;
	width: number;
	height: number;
}

export interface DeviceInfo {
	modelName: string;
	productName: string;
}

export interface CompanionDevice {
	connect(): Promise<void>;
	close(): Promise<void>;
	clearAll(): Promise<void>;
	getDeviceInfo(): DeviceInfo | null;
	getLcdButtons(): DeviceLcdButton[];
	getRgbButtonIndices(): number[];
	getLcdSegment(): DeviceLcdSegmentInfo | null;
	fillLcdButton(index: number, rgbaBuf: Buffer): Promise<void>;
	fillRgbButton(index: number, r: number, g: number, b: number): Promise<void>;
	fillLcdBar(imageBuffer: Buffer): Promise<void>;
	setOnPress(handler: ButtonPressHandler): void;
	setOnRelease(handler: ButtonReleaseHandler): void;
	setOnSwipe(handler: LcdSwipeHandler): void;
	setOnDisconnect(handler: DeviceDisconnectHandler): void;
}
