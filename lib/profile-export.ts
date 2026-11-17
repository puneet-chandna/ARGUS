import { crc32 } from "node:zlib";

export function csv(rows: readonly (readonly unknown[])[]) {
  return rows.map(row => row.map(value => {
    const original = String(value ?? "");
    // A filename or profile field must not become a spreadsheet formula.
    const text = /^[\s\p{Cc}]*[=+@-]/u.test(original) ? `'${original}` : original;
    return `"${text.replaceAll('"', '""')}"`;
  }).join(",")).join("\r\n") + "\r\n";
}

// ZIP stores these small text files without compression; it needs no native binary.
export function zip(files: Record<string, string>) {
  const locals: Buffer[] = [], entries: Buffer[] = [];
  let offset = 0, centralSize = 0;
  for (const [name, content] of Object.entries(files)) {
    const filename = Buffer.from(name);
    const bytes = Buffer.from(content);
    const checksum = crc32(bytes);
    const local = Buffer.alloc(30);
    const entry = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(33, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(filename.length, 26);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(20, 4);
    local.copy(entry, 6, 4, 28);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, filename, bytes);
    entries.push(entry, filename);
    offset += local.length + filename.length + bytes.length;
    centralSize += entry.length + filename.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length / 2, 8);
  end.writeUInt16LE(entries.length / 2, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...entries, end]);
}
