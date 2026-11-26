import Papa from 'papaparse';

const FORMULA_PREFIX_RE = /^[=+\-@\t\r]/;

/**
 * Neutralizes CSV spreadsheet formula injection (OWASP CSV Injection) while preserving numbers and plain strings.
 */
export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  if (FORMULA_PREFIX_RE.test(str)) {
    return `'${str}`;
  }
  return str;
}

/**
 * Sanitizes an array of row objects and serializes them safely with PapaParse.
 */
export function serializeSafeCsv(
  rows: Array<Record<string, unknown>>,
  columns?: string[],
): string {
  const safeRows = rows.map((row) => {
    const out: Record<string, string> = {};
    const keys = columns ?? Object.keys(row);
    for (const key of keys) {
      out[key] = escapeCsvCell(row[key]);
    }
    return out;
  });

  return Papa.unparse(safeRows, {
    columns,
    quotes: true,
    newline: '\r\n',
  });
}

/**
 * Streams large datasets in chunks as a UTF-8 CSV ReadableStream to prevent buffering huge exports in memory.
 */
export function createChunkedCsvStream(
  rows: Array<Record<string, unknown>>,
  columns?: string[],
  chunkSize = 250,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const keys = columns ?? (rows[0] ? Object.keys(rows[0]) : []);

  return new ReadableStream<Uint8Array>({
    start(controller) {
      // UTF-8 BOM for clean Excel compatibility
      controller.enqueue(new Uint8Array([0xef, 0xbb, 0xbf]));
      if (keys.length === 0) {
        controller.close();
        return;
      }
      const headerLine = Papa.unparse([keys], { quotes: true, header: false });
      controller.enqueue(encoder.encode(`${headerLine}\r\n`));

      for (let i = 0; i < rows.length; i += chunkSize) {
        const slice = rows.slice(i, i + chunkSize).map((row) => {
          const ordered: string[] = [];
          for (const key of keys) {
            ordered.push(escapeCsvCell(row[key]));
          }
          return ordered;
        });
        const chunkCsv = Papa.unparse(slice, { quotes: true, header: false, newline: '\r\n' });
        controller.enqueue(encoder.encode(`${chunkCsv}\r\n`));
      }
      controller.close();
    },
  });
}
