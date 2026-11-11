/**
 * Minimal, dependency-free ZIP writer.
 *
 * Why not a library? The packer's whole selling point is `npx aibundle` with no
 * install step and no supply-chain surface. A zip with *stored* (uncompressed)
 * entries is ~120 lines and every unzip tool on earth reads it.
 *
 * Correctness notes:
 * - CRC-32 is computed with the standard reflected polynomial (`0xEDB88320`).
 * - No data descriptor is used; sizes and CRC are known before the local header
 *   is written, which keeps the file valid for streaming readers too.
 * - Timestamps use the DOS date/time format, clamped to the representable range.
 * - Zip64 is not implemented: the writer throws if any input would need it, so a
 *   caller can fall back rather than emit a corrupt archive.
 *
 * @module renderers/zip
 */

/** One archive member. */
export interface ZipEntry {
  /** POSIX path inside the archive. */
  path: string;
  content: string | Buffer;
}

export interface ZipOptions {
  /** Timestamp stamped on every member. Defaults to now. */
  mtime?: Date;
  /** Compression method stored in the header. Only `0` (stored) is produced. */
  level?: 0;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

/** CRC-32 of a buffer (IEEE 802.3, the one ZIP uses). */
export function crc32(buffer: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** DOS date/time pair for the ZIP local header. */
export function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  const time =
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    Math.floor(date.getSeconds() / 2);
  const day =
    ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time: time & 0xffff, date: day & 0xffff };
}

const MAX_UINT32 = 0xffffffff;

/**
 * Build a ZIP archive.
 *
 * @param entries members in archive order
 * @param options `mtime` for reproducible builds
 * @returns the archive bytes
 */
export function renderZip(
  entries: readonly ZipEntry[],
  options: ZipOptions = {},
): Buffer {
  const mtime = options.mtime ?? new Date();
  const { time, date } = dosDateTime(mtime);

  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.path.replace(/\\/g, "/"), "utf8");
    const data =
      typeof entry.content === "string"
        ? Buffer.from(entry.content, "utf8")
        : Buffer.from(entry.content);
    const crc = crc32(data);

    if (
      offset > MAX_UINT32 ||
      data.length > MAX_UINT32 ||
      name.length > 0xffff
    ) {
      throw new Error(
        `zip64 not supported: archive too large for entry "${entry.path}"`,
      );
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length

    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs: -rw-r--r-- (unsigned!)
    central.writeUInt32LE(offset, 42);

    centrals.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  if (
    offset > MAX_UINT32 ||
    centralBuffer.length > MAX_UINT32 ||
    entries.length > 0xffff
  ) {
    throw new Error(
      "zip64 not supported: too many entries or archive too large",
    );
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, centralBuffer, end]);
}

/**
 * Read back the central directory of an archive produced by {@link renderZip}.
 *
 * Used by the test suite to prove the archive is well-formed without shelling
 * out to `unzip`.
 */
export function readZipEntries(
  archive: Uint8Array,
): Array<{ path: string; size: number; crc: number }> {
  const buffer = Buffer.from(archive);
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0)
    throw new Error("not a zip archive: no end-of-central-directory record");
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  const out: Array<{ path: string; size: number; crc: number }> = [];
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50)
      throw new Error("corrupt central directory");
    const crc = buffer.readUInt32LE(offset + 16);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const path = buffer
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString("utf8");
    out.push({ path, size, crc });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}
