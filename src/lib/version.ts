export function parseSemVer(v: string): number[] {
  return v.replace(/^v/i, "").trim().split(".").map((n) => parseInt(n, 10) || 0);
}

export function isNewerSemver(remote: string, current: string): boolean {
  const r = parseSemVer(remote);
  const c = parseSemVer(current);
  const len = Math.max(r.length, c.length);
  for (let i = 0; i < len; i++) {
    const rVal = r[i] || 0;
    const cVal = c[i] || 0;
    if (rVal > cVal) return true;
    if (rVal < cVal) return false;
  }
  return false;
}
