import type { IdGenerator } from "./base.ts";
import { SessionError } from "./storage.ts";

const MAX_UUID_TIMESTAMP = 0xffffffffffff;

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(length);
	if (globalThis.crypto?.getRandomValues) {
		globalThis.crypto.getRandomValues(bytes);
		return bytes;
	}
	for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
	return bytes;
}

function assertTimestamp(timestamp: number): void {
	if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > MAX_UUID_TIMESTAMP) {
		throw new SessionError("invalid_payload", `Invalid UUIDv7 timestamp: ${timestamp}`);
	}
}

/** Session-local UUIDv7 generator with follower-id timestamp support. */
export class UuidV7Generator implements IdGenerator {
	private readonly now: () => number;
	private lastAutomaticTimestamp = -1;
	private sequence = 0;

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	next(timestampMs?: number): string {
		let timestamp: number;
		if (timestampMs === undefined) {
			const current = Math.floor(this.now());
			assertTimestamp(current);
			if (current > this.lastAutomaticTimestamp) {
				this.lastAutomaticTimestamp = current;
				this.sequence = 0;
			} else {
				this.sequence++;
				if (this.sequence > 0x3fffffff) {
					this.lastAutomaticTimestamp++;
					this.sequence = 0;
				}
			}
			timestamp = this.lastAutomaticTimestamp;
		} else {
			assertTimestamp(timestampMs);
			timestamp = timestampMs;
		}

		const random = randomBytes(10);
		const bytes = new Uint8Array(16);
		bytes[0] = Math.floor(timestamp / 0x10000000000) & 0xff;
		bytes[1] = Math.floor(timestamp / 0x100000000) & 0xff;
		bytes[2] = Math.floor(timestamp / 0x1000000) & 0xff;
		bytes[3] = Math.floor(timestamp / 0x10000) & 0xff;
		bytes[4] = Math.floor(timestamp / 0x100) & 0xff;
		bytes[5] = timestamp & 0xff;
		bytes[6] = 0x70 | (random[0]! & 0x0f);
		bytes[7] = random[1]!;
		bytes[8] = 0x80 | (random[2]! & 0x3f);
		for (let index = 9; index < bytes.length; index++) bytes[index] = random[index - 6]!;

		if (timestampMs === undefined && this.sequence > 0) {
			bytes[10] = (bytes[10]! & 0xc0) | ((this.sequence >>> 24) & 0x3f);
			bytes[11] = (this.sequence >>> 16) & 0xff;
			bytes[12] = (this.sequence >>> 8) & 0xff;
			bytes[13] = this.sequence & 0xff;
		}

		const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
		return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
	}

	static timestamp(id: string): number {
		if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
			throw new SessionError("invalid_payload", `Invalid UUIDv7: ${id}`);
		}
		return Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
	}
}
