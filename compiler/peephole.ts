// ═══════════════════════════════════════════════════════════════
// AntLisp Pipeline — Phase 7: Peephole Optimization
// ═══════════════════════════════════════════════════════════════

export function peephole(lines: string[]): string[] {
  let output = [...lines];

  // Pass 1: Dead store elimination.
  // Remove SET rX <val> when the very next non-blank, non-comment, non-label line
  // is also SET rX <val2> (same register).
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < output.length - 1; i++) {
      const line = output[i].trim();
      const m1 = line.match(/^SET (r\d) .+/);
      if (!m1) continue;
      const reg = m1[1];
      for (let j = i + 1; j < output.length; j++) {
        const next = output[j].trim();
        if (next === '') continue;
        if (next.startsWith(';')) continue;
        if (next.endsWith(':')) break;  // label — not safe
        const m2 = next.match(/^SET (r\d) .+/);
        if (m2 && m2[1] === reg) {
          output.splice(i, 1);
          i--;
          changed = true;
        }
        break;
      }
    }
  }

  // Pass 2: Remove redundant JMP instructions that jump to a label which
  // would be reached by fall-through.
  for (let i = 0; i < output.length; i++) {
    const line = output[i].trim();
    if (!line.startsWith('JMP ')) continue;
    const target = line.split(/\s+/)[1];
    let redundant = false;
    for (let j = i + 1; j < output.length; j++) {
      const next = output[j].trim();
      if (next === '') continue;
      if (next.endsWith(':')) {
        const label = next.slice(0, -1);
        if (label === target) { redundant = true; break; }
        continue;
      }
      break;
    }
    if (redundant) {
      output.splice(i, 1);
      i--;
    }
  }

  return output;
}
