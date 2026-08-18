/**
 * RFC 4180 CSV reader.
 *
 * Hand-written and dependency-free on purpose: this module runs in the browser
 * as well as in the generator, and review text in the export contains embedded
 * commas, quotes, and newlines, so a naive split(",") corrupts real data.
 */

/** Parse CSV text into rows of raw string fields. */
export function parseRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let sawAnyField = false;

  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; // strip BOM

  while (i < text.length) {
    const c = text[i]!;

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      // Newlines inside quotes are literal content (review bodies rely on this).
      field += c;
      i++;
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      sawAnyField = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      sawAnyField = true;
      i++;
      continue;
    }
    if (c === "\r") {
      i++; // CRLF: the \n does the work
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      sawAnyField = false;
      i++;
      continue;
    }
    field += c;
    sawAnyField = true;
    i++;
  }

  if (field.length > 0 || sawAnyField || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Parse CSV into records keyed by header name.
 *
 * Headers are matched case-insensitively with whitespace collapsed, because the
 * export's column names are human-facing ("Watched Date") and have shifted
 * before.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const rows = parseRows(text);
  if (rows.length === 0) return [];
  const headers = rows[0]!.map(canonicalHeader);
  const out: Record<string, string>[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]!;
    // A trailing newline yields one empty row; skip it rather than emitting junk.
    if (row.length === 1 && row[0] === "") continue;
    const rec: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) rec[headers[c]!] = row[c] ?? "";
    out.push(rec);
  }
  return out;
}

export function canonicalHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, " ");
}
