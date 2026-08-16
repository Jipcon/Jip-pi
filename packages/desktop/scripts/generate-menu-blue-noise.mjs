import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const DITHER_ALPHA = 1;
const outputDirectory = fileURLToPath(new URL("../src/renderer/assets/", import.meta.url));

function randomValues(size, seed) {
	const values = new Float64Array(size * size);
	let state = seed >>> 0;
	for (let index = 0; index < values.length; index += 1) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		values[index] = (state >>> 0) / 0x1_0000_0000;
	}
	return values;
}

function blurToroidal(values, size) {
	const kernel = [1, 4, 6, 4, 1];
	const horizontal = new Float64Array(values.length);
	const blurred = new Float64Array(values.length);
	for (let y = 0; y < size; y += 1) {
		for (let x = 0; x < size; x += 1) {
			let sum = 0;
			for (let offset = -2; offset <= 2; offset += 1) {
				const sampleX = (x + offset + size) % size;
				sum += values[y * size + sampleX] * kernel[offset + 2];
			}
			horizontal[y * size + x] = sum / 16;
		}
	}
	for (let y = 0; y < size; y += 1) {
		for (let x = 0; x < size; x += 1) {
			let sum = 0;
			for (let offset = -2; offset <= 2; offset += 1) {
				const sampleY = (y + offset + size) % size;
				sum += horizontal[sampleY * size + x] * kernel[offset + 2];
			}
			blurred[y * size + x] = sum / 16;
		}
	}
	return blurred;
}

function blueNoiseMask(size, seed) {
	let values = randomValues(size, seed);
	for (let pass = 0; pass < 3; pass += 1) {
		const blurred = blurToroidal(values, size);
		const highPass = new Float64Array(values.length);
		for (let index = 0; index < values.length; index += 1) {
			highPass[index] = values[index] - blurred[index];
		}
		values = highPass;
	}
	const threshold = [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
	return values.map((value) => (value >= threshold ? 1 : 0));
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
	let value = index;
	for (let bit = 0; bit < 8; bit += 1) {
		value = (value & 1) === 1 ? 0xedb8_8320 ^ (value >>> 1) : value >>> 1;
	}
	return value >>> 0;
});

function crc32(buffer) {
	let crc = 0xffff_ffff;
	for (const byte of buffer) {
		crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffff_ffff) >>> 0;
}

function pngChunk(type, data) {
	const typeBytes = Buffer.from(type, "ascii");
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const checksum = Buffer.alloc(4);
	checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
	return Buffer.concat([length, typeBytes, data, checksum]);
}

function encodePng(size, mask) {
	const scanlines = Buffer.alloc(size * (size * 4 + 1));
	for (let y = 0; y < size; y += 1) {
		const rowStart = y * (size * 4 + 1);
		scanlines[rowStart] = 0;
		for (let x = 0; x < size; x += 1) {
			const pixelStart = rowStart + 1 + x * 4;
			scanlines[pixelStart] = 255;
			scanlines[pixelStart + 1] = 255;
			scanlines[pixelStart + 2] = 255;
			scanlines[pixelStart + 3] = mask[y * size + x] === 1 ? DITHER_ALPHA : 0;
		}
	}
	const header = Buffer.alloc(13);
	header.writeUInt32BE(size, 0);
	header.writeUInt32BE(size, 4);
	header[8] = 8;
	header[9] = 6;
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		pngChunk("IHDR", header),
		pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

mkdirSync(outputDirectory, { recursive: true });
for (const [fileName, size, seed] of [
	["menu-blue-noise-1x.png", 64, 0x6d_65_6e_75],
	["menu-blue-noise-2x.png", 128, 0x64_69_74_68],
]) {
	const mask = blueNoiseMask(size, seed);
	writeFileSync(new URL(fileName, new URL("../src/renderer/assets/", import.meta.url)), encodePng(size, mask));
}
