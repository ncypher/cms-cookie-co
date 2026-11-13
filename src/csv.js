// Spreadsheet (CSV) writing, shared with tests. Kept out of worker.js because workerd treats every
// named export of the entry module as a handler.
// A cell that starts like a formula (= + - @) gets a leading ' so Excel/Sheets show it as text.
export function csvCell(v) {
  if (v == null) return "";
  let t = String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(t)) t = "'" + t;
  return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}
export function toCsv(rows) { return "\uFEFF" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n"; }
