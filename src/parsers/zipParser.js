import { inflateRawSync } from 'node:zlib';
import { logger } from '../logger.js';

const MAX_ZIP_ENTRIES = 200;
const DEFAULT_MAX_ENTRY_BYTES = 25 * 1024 * 1024;

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

export class ZipError extends Error {
  constructor(message, code = 'INVALID') {
    super(message);
    this.name = 'ZipError';
    this.code = code;
    // Logged here (at the moment of every `throw new ZipError`) so no ZIP failure goes unrecorded
    logger.error(`ZIP error: ${message}`, { code });
  }
}

/** OS / tooling junk that shows up inside zips and is never a real document */
function isJunkEntry(path) {
  const base = path.split('/').pop();
  return (
    path.startsWith('__MACOSX/') ||
    base.startsWith('._') ||
    base === '.DS_Store' ||
    base.toLowerCase() === 'thumbs.db' ||
    base === 'desktop.ini'
  );
}

function findEndOfCentralDirectory(buf) {
  // EOCD is 22 bytes + up to 65535 bytes of trailing comment
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}


export function listZipEntries(buffer, { maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw new ZipError('file is too small to be a valid ZIP archive');
  }

  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw new ZipError('not a valid ZIP archive (end-of-central-directory record not found)');

  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);

  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipError('ZIP64 archives are not supported', 'UNSUPPORTED');
  }
  if (totalEntries > MAX_ZIP_ENTRIES) {
    throw new ZipError(`archive has ${totalEntries} entries (limit is ${MAX_ZIP_ENTRIES})`, 'TOO_LARGE');
  }
  if (cdOffset + cdSize > buffer.length) {
    throw new ZipError('ZIP central directory is truncated or corrupt');
  }

  const entries = [];
  let junkCount = 0;
  let pos = cdOffset;

  for (let i = 0; i < totalEntries; i++) {
    if (pos + 46 > buffer.length || buffer.readUInt32LE(pos) !== SIG_CENTRAL) {
      throw new ZipError('ZIP central directory is corrupt');
    }
    const flags = buffer.readUInt16LE(pos + 8);
    const method = buffer.readUInt16LE(pos + 10);
    let compressedSize = buffer.readUInt32LE(pos + 20);
    let size = buffer.readUInt32LE(pos + 24);
    const nameLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    let localOffset = buffer.readUInt32LE(pos + 42);

    if (size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      let ex = pos + 46 + nameLen;
      const exEnd = ex + extraLen;
      while (ex + 4 <= exEnd) {
        const id = buffer.readUInt16LE(ex);
        const len = buffer.readUInt16LE(ex + 2);
        if (id === 0x0001) {
          let f = ex + 4;
          const next = () => {
            const v = Number(buffer.readBigUInt64LE(f));
            f += 8;
            return v;
          };
          if (size === 0xffffffff && f + 8 <= ex + 4 + len) size = next();
          if (compressedSize === 0xffffffff && f + 8 <= ex + 4 + len) compressedSize = next();
          if (localOffset === 0xffffffff && f + 8 <= ex + 4 + len) localOffset = next();
          break;
        }
        ex += 4 + len;
      }
    }
  const rawName = buffer.toString(flags & 0x800 ? 'utf8' : 'latin1', pos + 46, pos + 46 + nameLen);
    pos += 46 + nameLen + extraLen + commentLen;

    const path = rawName.replace(/\\/g, '/');
    if (path.endsWith('/')) continue; // directory entry
    if (isJunkEntry(path)) {
      junkCount += 1;
      continue;
    }

    const encrypted = (flags & 0x1) === 1;

    entries.push({
      index: i,
      path,
      name: path.split('/').pop(),
      size,
      compressedSize,
      encrypted,
      read() {
        if (encrypted) throw new ZipError(`"${path}" is password protected`, 'PASSWORD');
        if (method !== 0 && method !== 8) {
          throw new ZipError(`"${path}" uses unsupported compression method ${method}`, 'UNSUPPORTED');
        }
        if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== SIG_LOCAL) {
          throw new ZipError(`"${path}" has a corrupt local header`);
        }
        // The local header's name/extra lengths can differ from the central directory's
        const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
        const dataEnd = dataStart + compressedSize;
        if (dataEnd > buffer.length) throw new ZipError(`"${path}" is truncated`);

        const raw = buffer.subarray(dataStart, dataEnd);
        if (method === 0) {
          if (raw.length > maxEntryBytes) throw new ZipError(`"${path}" is larger than the allowed entry size`, 'TOO_LARGE');
          return Buffer.from(raw);
        }
        try {
         return inflateRawSync(raw, { maxOutputLength: Math.max(1, maxEntryBytes) });
        } catch (err) {
          if (err?.code === 'ERR_BUFFER_TOO_LARGE') {
            throw new ZipError(`"${path}" expands beyond ${Math.round(maxEntryBytes / (1024 * 1024))} MB (possible zip bomb)`, 'TOO_LARGE');
          }
          throw new ZipError(`"${path}" could not be decompressed (${err.message})`);
        }
      }
    });
  }

  return { entries, junkCount };
}
