import fs from 'node:fs/promises';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const inflateRaw = promisify(zlib.inflateRaw);

/**
 * A read-only ZIP reader, just enough for a Spotify data export.
 *
 * Hand-written rather than a dependency because the whole of what we need is
 * "list the entries, hand me one of them": the archive is a flat set of JSON
 * files, deflated, and everything else in the format — encryption, spanning,
 * data descriptors — cannot occur in an export. Node ships the inflater; what
 * is missing is only the container, and that is the ~150 lines below.
 *
 * Entries are read individually from their offsets rather than by streaming
 * the archive front to back, so the 470 MB export costs one open file handle
 * and one entry's worth of memory (~13 MB) at a time.
 */

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;

/** Fields Postgres never sees; only what picking one entry out requires. */
export interface ZipEntry {
	name: string;
	/** 0 = stored, 8 = deflate. Anything else is rejected on read. */
	method: number;
	compressedSize: number;
	uncompressedSize: number;
	/** Offset of the LOCAL header, which is not where the data starts. */
	localHeaderOffset: number;
}

export class ZipArchive {
	private constructor(
		private readonly handle: Awaited<ReturnType<typeof fs.open>>,
		readonly entries: ZipEntry[]
	) {}

	static async open(path: string): Promise<ZipArchive> {
		const handle = await fs.open(path, 'r');
		try {
			const { size } = await handle.stat();
			const { offset, count } = await readEndRecord(handle, size);
			const central = await read(handle, offset, size - offset);
			return new ZipArchive(handle, parseCentralDirectory(central, count));
		} catch (err) {
			await handle.close();
			throw err;
		}
	}

	async close(): Promise<void> {
		await this.handle.close();
	}

	/** The entry's bytes, inflated. */
	async read(entry: ZipEntry): Promise<Buffer> {
		// The central directory records the local header's offset, and the local
		// header carries its OWN name and extra-field lengths — which routinely
		// differ from the central copy's, so the data offset has to be computed
		// from the local header rather than assumed.
		const header = await read(this.handle, entry.localHeaderOffset, 30);
		const nameLen = header.readUInt16LE(26);
		const extraLen = header.readUInt16LE(28);
		const start = entry.localHeaderOffset + 30 + nameLen + extraLen;

		const raw = await read(this.handle, start, entry.compressedSize);
		if (entry.method === 0) return raw;
		if (entry.method !== 8) {
			throw new Error(`${entry.name}: unsupported compression method ${entry.method}`);
		}
		return (await inflateRaw(raw)) as Buffer;
	}
}

async function read(
	handle: Awaited<ReturnType<typeof fs.open>>,
	position: number,
	length: number
): Promise<Buffer> {
	const buffer = Buffer.allocUnsafe(length);
	let read = 0;
	while (read < length) {
		const { bytesRead } = await handle.read(buffer, read, length - read, position + read);
		if (bytesRead === 0) throw new Error('Unexpected end of zip file');
		read += bytesRead;
	}
	return buffer;
}

/**
 * Locates the central directory.
 *
 * The end-of-central-directory record sits at the very end of the file, except
 * that it may be followed by up to 64 KB of free-form comment — so it can only
 * be found by scanning backwards for its signature.
 */
async function readEndRecord(
	handle: Awaited<ReturnType<typeof fs.open>>,
	size: number
): Promise<{ offset: number; count: number }> {
	const tailLength = Math.min(size, 0xffff + 22);
	const tail = await read(handle, size - tailLength, tailLength);

	let eocd = -1;
	for (let i = tail.length - 22; i >= 0; i--) {
		if (tail.readUInt32LE(i) === EOCD_SIG) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new Error('Not a zip file (no end-of-central-directory record)');

	const count = tail.readUInt16LE(eocd + 10);
	const offset = tail.readUInt32LE(eocd + 16);

	// 0xFFFFFFFF is the sentinel meaning "the real value is in the ZIP64
	// record", which the locator 20 bytes earlier points at.
	if (offset !== 0xffffffff && count !== 0xffff) return { offset, count };

	const locator = eocd - 20;
	if (locator < 0 || tail.readUInt32LE(locator) !== EOCD64_LOCATOR_SIG) {
		throw new Error('Zip needs ZIP64 but carries no ZIP64 locator');
	}
	const eocd64Offset = Number(tail.readBigUInt64LE(locator + 8));
	const eocd64 = await read(handle, eocd64Offset, 56);
	if (eocd64.readUInt32LE(0) !== EOCD64_SIG) throw new Error('Corrupt ZIP64 end record');

	return {
		offset: Number(eocd64.readBigUInt64LE(48)),
		count: Number(eocd64.readBigUInt64LE(32))
	};
}

function parseCentralDirectory(buffer: Buffer, count: number): ZipEntry[] {
	const entries: ZipEntry[] = [];
	let p = 0;

	while (entries.length < count && p + 46 <= buffer.length) {
		if (buffer.readUInt32LE(p) !== CENTRAL_SIG) break;

		const nameLen = buffer.readUInt16LE(p + 28);
		const extraLen = buffer.readUInt16LE(p + 30);
		const commentLen = buffer.readUInt16LE(p + 32);

		const entry: ZipEntry = {
			// Export filenames are ASCII, but UTF-8 is the format's own answer for
			// anything else and is what the flag bit at offset 8 promises.
			name: buffer.toString('utf8', p + 46, p + 46 + nameLen),
			method: buffer.readUInt16LE(p + 10),
			compressedSize: buffer.readUInt32LE(p + 20),
			uncompressedSize: buffer.readUInt32LE(p + 24),
			localHeaderOffset: buffer.readUInt32LE(p + 42)
		};

		applyZip64Extra(entry, buffer.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen));
		entries.push(entry);
		p += 46 + nameLen + extraLen + commentLen;
	}

	return entries;
}

/**
 * ZIP64 stores the oversized values in an extra field, as a bare sequence of
 * 64-bit numbers — one for each of uncompressed size, compressed size and
 * local header offset that was written as the 0xFFFFFFFF sentinel, in that
 * fixed order and with the others simply absent.
 */
function applyZip64Extra(entry: ZipEntry, extra: Buffer): void {
	let p = 0;
	while (p + 4 <= extra.length) {
		const id = extra.readUInt16LE(p);
		const size = extra.readUInt16LE(p + 2);
		if (id === 0x0001) {
			let q = p + 4;
			const next = (): number => {
				const v = Number(extra.readBigUInt64LE(q));
				q += 8;
				return v;
			};
			if (entry.uncompressedSize === 0xffffffff && q + 8 <= p + 4 + size) {
				entry.uncompressedSize = next();
			}
			if (entry.compressedSize === 0xffffffff && q + 8 <= p + 4 + size) {
				entry.compressedSize = next();
			}
			if (entry.localHeaderOffset === 0xffffffff && q + 8 <= p + 4 + size) {
				entry.localHeaderOffset = next();
			}
			return;
		}
		p += 4 + size;
	}
}
