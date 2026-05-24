'use strict';

function readVarint(buf, pos) {
  let value = 0;
  let shift = 0;
  while (pos < buf.length) {
    const byte = buf[pos++];
    value += (byte & 0x7f) * Math.pow(2, shift);
    if (byte < 0x80) return { value, pos };
    shift += 7;
    if (shift > 53) throw new Error('varint too large');
  }
  throw new Error('unexpected eof');
}

function encodeVarint(value) {
  const out = [];
  let n = value;
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('invalid varint value');
  do {
    let byte = n & 0x7f;
    n = Math.floor(n / 128);
    if (n) byte |= 0x80;
    out.push(byte);
  } while (n);
  return Buffer.from(out);
}

function encodeKey(field, wire) {
  return encodeVarint(field * 8 + wire);
}

function encodeBytes(field, payload) {
  return Buffer.concat([encodeKey(field, 2), encodeVarint(payload.length), payload]);
}

function encodeString(field, value) {
  return encodeBytes(field, Buffer.from(value, 'utf8'));
}

function parseFields(buf) {
  const fields = [];
  let pos = 0;
  while (pos < buf.length) {
    const key = readVarint(buf, pos);
    pos = key.pos;
    const field = Math.floor(key.value / 8);
    const wire = key.value & 7;
    let start = pos;
    let end;
    if (wire === 0) {
      pos = readVarint(buf, pos).pos;
      end = pos;
    } else if (wire === 1) {
      pos += 8;
      end = pos;
    } else if (wire === 2) {
      const len = readVarint(buf, pos);
      start = len.pos;
      end = start + len.value;
      pos = end;
    } else if (wire === 5) {
      pos += 4;
      end = pos;
    } else {
      throw new Error(`unsupported wire type ${wire}`);
    }
    if (end > buf.length) throw new Error('field exceeds buffer');
    fields.push({ field, wire, start, end });
  }
  return fields;
}

function firstString(buf, fieldNo) {
  for (const item of parseFields(buf)) {
    if (item.field === fieldNo && item.wire === 2) {
      return buf.subarray(item.start, item.end).toString('utf8');
    }
  }
  return null;
}

function repeatedStrings(buf, fieldNo) {
  const values = [];
  for (const item of parseFields(buf)) {
    if (item.field === fieldNo && item.wire === 2) {
      values.push(buf.subarray(item.start, item.end).toString('utf8'));
    }
  }
  return values;
}

function parsePayload(payload) {
  let project = null;
  let uris = [];
  for (const item of parseFields(payload)) {
    if (item.field === 17 && item.wire === 2) {
      const link = payload.subarray(item.start, item.end);
      project = firstString(link, 18);
      uris = repeatedStrings(link, 7).map((uri) => {
        try {
          return decodeURIComponent(uri).replace(/\/+$/, '');
        } catch (_) {
          return uri.replace(/\/+$/, '');
        }
      });
    }
  }
  return {
    title: firstString(payload, 1) || '',
    project,
    uris: Array.from(new Set(uris)).sort(),
  };
}

function parseSummaryEntries(buf, options = {}) {
  const encodedPayload = Boolean(options.encodedPayload);
  const tolerant = Boolean(options.tolerant);
  const summaries = [];
  const fields = parseFields(buf);
  let idx = 0;
  for (const outer of fields) {
    if (outer.field !== 1 || outer.wire !== 2) continue;
    const entry = buf.subarray(outer.start, outer.end);
    const entryFields = parseFields(entry);
    const idField = entryFields.find((item) => item.field === 1 && item.wire === 2);
    const payloadField = entryFields.find((item) => item.field === 2 && item.wire === 2);
    if (!idField || !payloadField) continue;
    const cid = entry.subarray(idField.start, idField.end).toString('utf8');
    let payload = entry.subarray(payloadField.start, payloadField.end);
    if (encodedPayload) {
      try {
        payload = Buffer.from(payload.toString('ascii'), 'base64');
      } catch (_) {
        payload = Buffer.alloc(0);
      }
    }
    let parsed = { title: '', project: null, uris: [] };
    let parseError = null;
    if (payload.length) {
      try {
        parsed = parsePayload(payload);
      } catch (error) {
        if (!tolerant) throw error;
        parseError = error.message;
      }
    }
    summaries.push({ idx, cid, payload, parseError, ...parsed });
    idx++;
  }
  return summaries;
}

module.exports = { readVarint, encodeVarint, encodeBytes, encodeString, parseFields, parseSummaryEntries };
