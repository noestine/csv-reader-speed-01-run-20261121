// Fast drop-in for csv-reader 1.0.0 (make.fun's reference CSV reader).
// Returns exactly the same {columns, rows, errors} for every {text, header},
// but parses with indexOf-based jumps and slice() instead of a per-character loop.
//
// Semantics (from the reference):
// - U+FEFF at the very start is dropped.
// - A record ends at LF or CRLF; an empty line is no record.
// - Outside quotes a CR not followed by LF is dropped (stray_cr).
// - A field opening with a quote runs to the next non-doubled quote; "" inside is
//   one quote; CRLF/lone CR inside quotes read as LF; what follows the closing
//   quote up to the next comma or line break is appended as-is (quote_junk);
//   a quote that never closes is a literal and the text after it is re-read as
//   unquoted (unterminated_quote). A quote inside an unquoted field is literal.
// - Fields stay strings, never trimmed or converted.
// - columns is the first record when header is true else null; rows are padded
//   with "" (short_row) or cut (long_row) to the first record's width.
// - errors are {code, line, row} in the order met; line is the 1-based line the
//   record starts on (counting every LF, CRLF and lone CR inside quotes);
//   row is the record's index in rows (null for the header).
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to the next.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input, computed faster. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xFEFF) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;
  // The next LF at or after the current field's start, cached per record: an
  // unquoted field's terminator is the nearer of the next comma and this LF,
  // and the LF does not move while only unquoted fields are read. A quoted
  // field may swallow LFs, so it invalidates the cache (-1 = unknown).
  let recLF = -1;

  function pushStrayCr(count) {
    for (let k = 0; k < count; k++) errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
  }

  // Reads an unquoted field starting at pos, with initial value `init`.
  // Returns {value, ended, added} (added = characters this call kept).
  // A stray CR inside the field is dropped (stray_cr); the field ends at the
  // next comma, line break, or end of text. indexOf jumps to the delimiter, so
  // the field is one slice, not a per-character loop.
  function readUnquoted(init) {
    if (recLF === -1 || recLF < pos) recLF = text.indexOf('\n', pos);
    const iComma = text.indexOf(',', pos);
    const iLF = recLF;
    let end, isComma;
    if (iComma === -1) { end = iLF; isComma = false; }
    else if (iLF === -1) { end = iComma; isComma = true; }
    else if (iComma < iLF) { end = iComma; isComma = true; }
    else { end = iLF; isComma = false; }

    let contentEnd, newPos, ended, advLine;
    if (end === -1) {
      contentEnd = n; newPos = n; ended = END; advLine = false;
    } else if (isComma) {
      contentEnd = end; newPos = end + 1; ended = COMMA; advLine = false;
    } else {
      contentEnd = (end > pos && text.charCodeAt(end - 1) === 13) ? end - 1 : end;
      newPos = end + 1; ended = LINE_BREAK; advLine = true;
    }
    const seg = text.slice(pos, contentEnd);
    let value, added;
    if (seg.indexOf('\r') === -1) {
      value = init + seg;
      added = seg.length;
    } else {
      // Rare: stray CRs inside the field. Drop them, one error each.
      const parts = seg.split('\r');
      const count = parts.length - 1;
      pushStrayCr(count);
      value = init + parts.join('');
      added = seg.length - count;
    }
    pos = newPos;
    if (advLine) line++;
    return { value, ended, added };
  }

  // Reads a quoted field whose opening quote is at pos. Returns {value, ended}.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    // Find the closing quote: the next quote that is not doubled.
    let scan = pos + 1;
    let q = -1;
    let hasDoubled = false;
    while (true) {
      q = text.indexOf('"', scan);
      if (q === -1) break;
      if (text.charCodeAt(q + 1) === 34) { hasDoubled = true; scan = q + 2; continue; }
      break;
    }
    if (q === -1) {
      // The quote never closes: it is a literal, and the text after it is
      // read again as unquoted.
      pos = open + 1;
      line = openLine;
      recLF = -1;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      return readUnquoted('"');
    }
    const raw = text.slice(pos + 1, q);
    let value;
    const hasQ = hasDoubled;
    const hasCR = raw.indexOf('\r') !== -1;
    const hasLF = raw.indexOf('\n') !== -1;
    if (!hasQ && !hasCR && !hasLF) {
      value = raw;
    } else if (!hasQ && !hasCR) {
      // Only LFs inside: the value is the raw text; each LF is a line.
      value = raw;
      let c = 0, idx = -1;
      while ((idx = raw.indexOf('\n', idx + 1)) !== -1) c++;
      line += c;
    } else {
      // Doubled quotes and/or CRs: "" is one quote, CRLF and lone CR are LF.
      value = raw.replace(/""/g, '"').replace(/\r\n?/g, '\n');
      let cr = 0, lf = 0, crlf = 0, idx = -1;
      while ((idx = raw.indexOf('\r', idx + 1)) !== -1) cr++;
      idx = -1;
      while ((idx = raw.indexOf('\n', idx + 1)) !== -1) lf++;
      idx = -1;
      while ((idx = raw.indexOf('\r\n', idx + 1)) !== -1) crlf++;
      line += cr + lf - crlf;
    }
    recLF = -1;
    pos = q + 1;
    if (pos >= n) return { value, ended: END };
    const c = text.charCodeAt(pos);
    if (c === 44) { pos++; return { value, ended: COMMA }; }
    if (c === 10) { pos++; line++; return { value, ended: LINE_BREAK }; }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) { pos += 2; line++; return { value, ended: LINE_BREAK }; }
    // What follows the closing quote is appended as it stands, up to the next
    // comma or line break.
    const junk = readUnquoted(value);
    if (junk.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return junk;
  }

  // Fast path for a record with no quote in it: split the record on commas.
  // Returns the fields array, false (the record held only stray CRs: no record),
  // or null (a quote is present: use the field loop).
  function tryFastRecord() {
    const lf = text.indexOf('\n', pos);
    const recEnd = lf === -1 ? n : lf;
    let rec = text.slice(pos, recEnd);
    if (rec.indexOf('"') !== -1) return null;
    const atEOF = lf === -1;
    if (!atEOF && rec.charCodeAt(rec.length - 1) === 13) rec = rec.slice(0, -1);
    if (rec.indexOf('\r') !== -1) {
      const parts = rec.split('\r');
      pushStrayCr(parts.length - 1);
      rec = parts.join('');
    }
    if (rec === '') {
      pos = atEOF ? n : lf + 1;
      if (!atEOF) line++;
      return false;
    }
    const fields = rec.split(',');
    pos = atEOF ? n : lf + 1;
    if (!atEOF) line++;
    return fields;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) { pos++; line++; }
      else if (c === 13 && text.charCodeAt(pos + 1) === 10) { pos += 2; line++; }
      else break;
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = (header && columns === null) ? null : rows.length;
    recLF = -1;

    let fields = null;
    if (text.charCodeAt(pos) !== 34) {
      fields = tryFastRecord();
      if (fields === false) continue;
    }
    if (fields === null) {
      fields = [];
      let ended;
      let quoted = false;
      do {
        quoted = text.charCodeAt(pos) === 34;
        const f = quoted ? readQuoted() : readUnquoted('');
        fields.push(f.value);
        ended = f.ended;
      } while (ended === COMMA);
      // A line that held only stray CRs is left with no characters: no record.
      if (fields.length === 1 && fields[0] === '' && !quoted) continue;
    }

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
