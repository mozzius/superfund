/**
 * Just enough DAG-CBOR decoding for label stream frames, which are two CBOR
 * values back to back (header, then body). Handles ints, strings, bytes,
 * arrays, maps, tags (a CID comes back as its tagged payload), booleans,
 * null and 64-bit floats. Indefinite lengths and half/single floats aren't
 * valid DAG-CBOR, so they're rejected.
 */
export function decodeCborSequence(bytes: Uint8Array): unknown[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = new TextDecoder("utf-8", { fatal: true });
  let pos = 0;

  const need = (n: number) => {
    if (pos + n > bytes.length) throw new Error("truncated CBOR");
  };

  const readArg = (info: number): number => {
    if (info < 24) return info;
    switch (info) {
      case 24:
        need(1);
        return bytes[pos++]!;
      case 25: {
        need(2);
        const v = view.getUint16(pos);
        pos += 2;
        return v;
      }
      case 26: {
        need(4);
        const v = view.getUint32(pos);
        pos += 4;
        return v;
      }
      case 27: {
        need(8);
        const v = view.getBigUint64(pos);
        pos += 8;
        if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("CBOR integer too large");
        return Number(v);
      }
      default:
        throw new Error(`unsupported CBOR length encoding ${info}`);
    }
  };

  const readItem = (depth: number): unknown => {
    if (depth > 64) throw new Error("CBOR nested too deeply");
    need(1);
    const initial = bytes[pos++]!;
    const major = initial >> 5;
    const info = initial & 0x1f;

    if (major === 7) {
      switch (info) {
        case 20:
          return false;
        case 21:
          return true;
        case 22:
          return null;
        case 23:
          return undefined;
        case 27: {
          need(8);
          const v = view.getFloat64(pos);
          pos += 8;
          return v;
        }
        default:
          throw new Error(`unsupported CBOR simple value ${info}`);
      }
    }

    const arg = readArg(info);
    switch (major) {
      case 0:
        return arg;
      case 1:
        return -1 - arg;
      case 2: {
        need(arg);
        const v = bytes.slice(pos, pos + arg);
        pos += arg;
        return v;
      }
      case 3: {
        need(arg);
        const v = text.decode(bytes.subarray(pos, pos + arg));
        pos += arg;
        return v;
      }
      case 4: {
        const out: unknown[] = [];
        for (let i = 0; i < arg; i++) out.push(readItem(depth + 1));
        return out;
      }
      case 5: {
        const out: Record<string, unknown> = {};
        for (let i = 0; i < arg; i++) {
          const key = readItem(depth + 1);
          if (typeof key !== "string") throw new Error("CBOR map key is not a string");
          // defineProperty, so a "__proto__" key is just a key.
          Object.defineProperty(out, key, {
            value: readItem(depth + 1),
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
        return out;
      }
      default:
        // major 6: a tag (42 = CID). Keep whatever it wraps.
        return readItem(depth + 1);
    }
  };

  const items: unknown[] = [];
  while (pos < bytes.length) items.push(readItem(0));
  return items;
}
