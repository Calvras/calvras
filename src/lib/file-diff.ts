/** A contiguous diff hunk from the actual contents before and after a write. */
export function fileDiff(before: string, after: string) {
  const oldLines = before === "" ? [] : before.replace(/\r\n/g, "\n").split("\n");
  const newLines = after === "" ? [] : after.replace(/\r\n/g, "\n").split("\n");
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) { oldEnd--; newEnd--; }
  const rows: { old?: number; cur?: number; type: "ctx" | "del" | "add"; text: string }[] = [];
  if (start === oldEnd && start === newEnd) return rows;
  for (let i = Math.max(0, start - 3); i < start; i++) rows.push({ old: i + 1, cur: i + 1, type: "ctx", text: oldLines[i]! });
  for (let i = start; i < oldEnd; i++) rows.push({ old: i + 1, type: "del", text: oldLines[i]! });
  for (let i = start; i < newEnd; i++) rows.push({ cur: i + 1, type: "add", text: newLines[i]! });
  for (let i = 0; i < Math.min(3, oldLines.length - oldEnd); i++) rows.push({ old: oldEnd + i + 1, cur: newEnd + i + 1, type: "ctx", text: oldLines[oldEnd + i]! });
  return rows;
}
