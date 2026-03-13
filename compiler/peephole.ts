// ═══════════════════════════════════════════════════════════════
// AntLisp Pipeline — Phase 7: Peephole Optimization
// ═══════════════════════════════════════════════════════════════

const TERMINATORS = new Set(['JMP', 'MOVE', 'PICKUP', 'DROP']);
const JUMP_OPS = new Set(['JMP', 'JEQ', 'JNE', 'JGT', 'JLT']);

interface AsmBlock {
  labels: string[];     // label names (without colon)
  bodyLines: number[];  // indices into the output[] array
  body: string[];       // trimmed instruction strings
}

// Parse flat assembly lines into basic blocks.
// A block starts at a label (or the beginning of output) and ends at the
// next label or EOF.  Blank lines and comments are skipped in the body.
function parseBlocks(output: string[]): AsmBlock[] {
  const blocks: AsmBlock[] = [];
  let labels: string[] = [];
  let bodyLines: number[] = [];
  let body: string[] = [];

  for (let i = 0; i < output.length; i++) {
    const trimmed = output[i].trim();
    if (trimmed === '' || trimmed.startsWith(';')) continue;
    if (trimmed.endsWith(':')) {
      // A label after body instructions starts a new block
      if (body.length > 0) {
        blocks.push({ labels, bodyLines, body });
        labels = [];
        bodyLines = [];
        body = [];
      }
      labels.push(trimmed.slice(0, -1));
    } else {
      bodyLines.push(i);
      body.push(trimmed);
    }
  }
  if (body.length > 0) {
    blocks.push({ labels, bodyLines, body });
  }
  return blocks;
}

// Find the next label after a given line index (for fall-through normalization).
function findNextLabel(output: string[], afterLine: number): string | null {
  for (let i = afterLine + 1; i < output.length; i++) {
    const trimmed = output[i].trim();
    if (trimmed === '' || trimmed.startsWith(';')) continue;
    if (trimmed.endsWith(':')) return trimmed.slice(0, -1);
    return null;  // hit an instruction before any label
  }
  return null;
}

// Get the effective tail of a block, including a virtual JMP for fall-throughs.
function effectiveTail(block: AsmBlock, output: string[]): string[] {
  const { body, bodyLines } = block;
  if (body.length === 0) return [];
  const lastOp = body[body.length - 1].split(/\s+/)[0];
  if (TERMINATORS.has(lastOp)) return body;
  // Fall-through: append virtual JMP to next label
  const nextLabel = findNextLabel(output, bodyLines[bodyLines.length - 1]);
  if (!nextLabel) return body;
  return [...body, `JMP ${nextLabel}`];
}

let tailCounter = 0;

function tailMerge(output: string[], outputIdx: number[]): { lines: string[]; instrIndex: number[]; changed: boolean } {
  const blocks = parseBlocks(output);
  if (blocks.length < 2) return { lines: output, instrIndex: outputIdx, changed: false };

  // Build effective tails for each block
  const tails = blocks.map(b => effectiveTail(b, output));

  // Group blocks by their last instruction (quick filter)
  const groups = new Map<string, number[]>();
  for (let i = 0; i < blocks.length; i++) {
    const tail = tails[i];
    if (tail.length < 2) continue;
    const key = tail[tail.length - 1];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(i);
  }

  // Within each group, find longest common tail suffix
  type MergeGroup = { indices: number[]; tailLen: number };
  const merges: MergeGroup[] = [];

  for (const [, indices] of groups) {
    if (indices.length < 2) continue;

    // For each pair combination, find common tail length.
    // Then greedily form groups of blocks sharing the same tail.
    // Simple approach: find the longest tail shared by ALL blocks in the group,
    // then check subgroups if the full group doesn't meet the threshold.

    // Find max common tail across all blocks in this group
    const minLen = Math.min(...indices.map(i => tails[i].length));
    let commonLen = 0;
    outer:
    for (let t = 1; t <= minLen; t++) {
      const ref = tails[indices[0]][tails[indices[0]].length - t];
      for (let j = 1; j < indices.length; j++) {
        const tail = tails[indices[j]];
        if (tail[tail.length - t] !== ref) break outer;
      }
      commonLen = t;
    }

    // Try the full group first
    const N = indices.length;
    if (commonLen >= 2 && (N - 1) * commonLen - N > 0) {
      merges.push({ indices, tailLen: commonLen });
      continue;
    }

    // Try all pairs for longer tails
    for (let a = 0; a < indices.length; a++) {
      for (let b = a + 1; b < indices.length; b++) {
        const tailA = tails[indices[a]];
        const tailB = tails[indices[b]];
        const pairMin = Math.min(tailA.length, tailB.length);
        let pairCommon = 0;
        for (let t = 1; t <= pairMin; t++) {
          if (tailA[tailA.length - t] !== tailB[tailB.length - t]) break;
          pairCommon = t;
        }
        // For N=2, need tailLen >= 3
        if (pairCommon >= 3) {
          merges.push({ indices: [indices[a], indices[b]], tailLen: pairCommon });
        }
      }
    }
  }

  if (merges.length === 0) return { lines: output, instrIndex: outputIdx, changed: false };

  // Deduplicate: a block should only appear in one merge group.
  // Prefer the group with highest savings.
  merges.sort((a, b) => {
    const savA = (a.indices.length - 1) * a.tailLen - a.indices.length;
    const savB = (b.indices.length - 1) * b.tailLen - b.indices.length;
    return savB - savA;
  });

  const claimed = new Set<number>();
  const finalMerges: MergeGroup[] = [];
  for (const mg of merges) {
    if (mg.indices.some(i => claimed.has(i))) continue;
    mg.indices.forEach(i => claimed.add(i));
    finalMerges.push(mg);
  }

  if (finalMerges.length === 0) return { lines: output, instrIndex: outputIdx, changed: false };

  // Check for identical block dedup (special case: tail == entire body)
  // For identical blocks, rewrite jump targets instead of extracting a tail.
  const result = [...output];
  const resultIdx = [...outputIdx];
  const linesToDelete = new Set<number>();
  const labelsToDelete = new Set<string>();
  const labelRewrites = new Map<string, string>();
  const appendBlocks: string[] = [];
  const appendBlocksIdx: number[] = [];

  for (const { indices, tailLen } of finalMerges) {
    const tl = tails[indices[0]];
    const sharedTail = tl.slice(tl.length - tailLen);
    const block0 = blocks[indices[0]];

    // Check if this is full-block dedup (all blocks have identical effective tails
    // that cover their entire body)
    const isFullDedup = indices.every(i => tails[i].length === tailLen);

    if (isFullDedup) {
      // Identical block dedup: keep the first block, rewrite references to others
      const canonicalLabel = block0.labels[0];
      if (!canonicalLabel) continue;  // entry block with no label — skip dedup

      for (let k = 1; k < indices.length; k++) {
        const blk = blocks[indices[k]];
        for (const lbl of blk.labels) {
          labelRewrites.set(lbl, canonicalLabel);
          labelsToDelete.add(lbl);
        }
        for (const lineIdx of blk.bodyLines) {
          linesToDelete.add(lineIdx);
        }
      }
    } else {
      // Tail extraction: create shared tail block, truncate each block
      const tailLabel = `__tail_${tailCounter++}`;
      appendBlocks.push(`${tailLabel}:`);
      appendBlocksIdx.push(-1);
      // Use instrIndex from the first block's tail instructions
      const firstBlock = blocks[indices[0]];
      const firstRealBodyLen = firstBlock.body.length;
      for (let t = 0; t < sharedTail.length; t++) {
        appendBlocks.push(`  ${sharedTail[t]}`);
        // Determine instrIndex: for real body instructions, use the original;
        // for the virtual JMP, use -1
        const bodyPos = firstRealBodyLen - tailLen + t;
        if (bodyPos >= 0 && bodyPos < firstRealBodyLen) {
          appendBlocksIdx.push(outputIdx[firstBlock.bodyLines[bodyPos]]);
        } else {
          appendBlocksIdx.push(-1);
        }
      }

      for (const idx of indices) {
        const blk = blocks[idx];
        const tail = tails[idx];
        const realBodyLen = blk.body.length;
        const effectiveLen = tail.length;
        // How many real body instructions are part of the shared tail?
        // The tail might include a virtual JMP that isn't in the real body.
        const virtualJmp = effectiveLen > realBodyLen;
        const realTailLen = virtualJmp ? tailLen - 1 : tailLen;

        // Delete the tail instructions from this block
        for (let t = 0; t < realTailLen; t++) {
          const lineIdx = blk.bodyLines[realBodyLen - 1 - t];
          linesToDelete.add(lineIdx);
        }
        // Insert JMP to tail label after the last remaining instruction
        const insertAfter = realTailLen >= realBodyLen
          ? blk.bodyLines[0]  // all body lines removed; insert at first body position
          : blk.bodyLines[realBodyLen - realTailLen - 1];
        // We'll handle insertion by replacing the line after the last kept instruction
        // Actually, let's use a splice approach: mark deletions, then rebuild
        // For now, replace the first deleted line with the JMP and delete the rest
        const firstDeletedIdx = blk.bodyLines[realBodyLen - realTailLen];
        if (firstDeletedIdx !== undefined) {
          result[firstDeletedIdx] = `  JMP ${tailLabel}`;
          resultIdx[firstDeletedIdx] = -1;
          linesToDelete.delete(firstDeletedIdx);
        } else {
          // All body lines are tail; replace the first body line with JMP
          result[blk.bodyLines[0]] = `  JMP ${tailLabel}`;
          resultIdx[blk.bodyLines[0]] = -1;
          linesToDelete.delete(blk.bodyLines[0]);
        }
      }
    }
  }

  // Rebuild output: filter deleted lines, delete labels for deduped blocks, append tails
  const newOutput: string[] = [];
  const newOutputIdx: number[] = [];
  for (let i = 0; i < result.length; i++) {
    if (linesToDelete.has(i)) continue;
    const trimmed = result[i].trim();
    if (trimmed.endsWith(':') && labelsToDelete.has(trimmed.slice(0, -1))) continue;
    newOutput.push(result[i]);
    newOutputIdx.push(resultIdx[i]);
  }
  newOutput.push(...appendBlocks);
  newOutputIdx.push(...appendBlocksIdx);

  // Apply label rewrites to the combined output (including appended tail blocks)
  if (labelRewrites.size > 0) {
    for (let i = 0; i < newOutput.length; i++) {
      const trimmed = newOutput[i].trim();
      if (trimmed === '' || trimmed.startsWith(';')) continue;
      const tokens = trimmed.split(/\s+/);
      const op = tokens[0];
      if (op === 'JMP' && tokens[1] && labelRewrites.has(tokens[1])) {
        newOutput[i] = newOutput[i].replace(tokens[1], labelRewrites.get(tokens[1])!);
      } else if (JUMP_OPS.has(op) && tokens[3] && labelRewrites.has(tokens[3])) {
        newOutput[i] = newOutput[i].replace(tokens[3], labelRewrites.get(tokens[3])!);
      }
    }
  }

  return { lines: newOutput, instrIndex: newOutputIdx, changed: true };
}

export function peephole(lines: string[], instrIndex?: number[]): { lines: string[]; instrIndex: number[] } {
  let output = [...lines];
  let outputIdx = instrIndex ? [...instrIndex] : new Array(lines.length).fill(-1);
  tailCounter = 0;

  // All passes run in a fixed-point loop: removing a label can expose
  // dead stores, and removing a redundant JMP can orphan a label.
  let changed = true;
  while (changed) {
    changed = false;

    // Pass 0: Jump threading — rewrite jumps through trampoline blocks.
    // A trampoline is a label whose only instruction is JMP <target>.
    // Rewrite all references to jump directly to the final target.
    {
      // Scan to find trampoline labels
      const trampolines = new Map<string, string>();  // label → jump target
      let currentLabel: string | null = null;
      let instrCount = 0;
      let singleJmpTarget: string | null = null;
      for (const line of output) {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith(';')) continue;
        if (trimmed.endsWith(':')) {
          // Finalize previous label
          if (currentLabel !== null && instrCount === 1 && singleJmpTarget !== null) {
            trampolines.set(currentLabel, singleJmpTarget);
          }
          currentLabel = trimmed.slice(0, -1);
          instrCount = 0;
          singleJmpTarget = null;
        } else {
          instrCount++;
          if (instrCount === 1 && trimmed.startsWith('JMP ')) {
            singleJmpTarget = trimmed.split(/\s+/)[1];
          } else {
            singleJmpTarget = null;
          }
        }
      }
      // Finalize last label
      if (currentLabel !== null && instrCount === 1 && singleJmpTarget !== null) {
        trampolines.set(currentLabel, singleJmpTarget);
      }

      if (trampolines.size > 0) {
        // Resolve chains transitively
        const resolved = new Map<string, string>();
        for (const label of trampolines.keys()) {
          let target = trampolines.get(label)!;
          const visited = new Set<string>([label]);
          while (trampolines.has(target) && !visited.has(target)) {
            visited.add(target);
            target = trampolines.get(target)!;
          }
          resolved.set(label, target);
        }

        // Rewrite all jump operands
        for (let i = 0; i < output.length; i++) {
          const trimmed = output[i].trim();
          if (trimmed === '' || trimmed.startsWith(';') || trimmed.endsWith(':')) continue;
          const tokens = trimmed.split(/\s+/);
          const op = tokens[0];
          if (op === 'JMP' && tokens[1] && resolved.has(tokens[1])) {
            output[i] = output[i].replace(tokens[1], resolved.get(tokens[1])!);
            changed = true;
          } else if (JUMP_OPS.has(op) && tokens[3] && resolved.has(tokens[3])) {
            output[i] = output[i].replace(tokens[3], resolved.get(tokens[3])!);
            changed = true;
          }
        }
      }
    }

    // Pass 1: Tail merging.
    const tmResult = tailMerge(output, outputIdx);
    if (tmResult.changed) {
      output = tmResult.lines;
      outputIdx = tmResult.instrIndex;
      changed = true;
    }

    // Pass 2: Dead store elimination.
    // Remove SET rX <val> when the very next non-blank, non-comment, non-label line
    // is also SET rX <val2> (same register).
    let dseChanged = true;
    while (dseChanged) {
      dseChanged = false;
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
            outputIdx.splice(i, 1);
            i--;
            dseChanged = true;
            changed = true;
          }
          break;
        }
      }
    }

    // Pass 2b: Dead code after unconditional JMP.
    // Remove any instructions between an unconditional JMP and the next label,
    // since they are unreachable.
    {
      let i = 0;
      while (i < output.length) {
        const trimmed = output[i].trim();
        if (trimmed.startsWith('JMP ')) {
          // Delete all non-label, non-blank, non-comment lines until the next label
          let j = i + 1;
          while (j < output.length) {
            const next = output[j].trim();
            if (next === '' || next.startsWith(';')) { j++; continue; }
            if (next.endsWith(':')) break;  // hit a label — stop
            // This is an unreachable instruction — delete it
            output.splice(j, 1);
            outputIdx.splice(j, 1);
            changed = true;
            // Don't increment j since array shifted
          }
        }
        i++;
      }
    }

    // Pass 3: Remove redundant JMP instructions that jump to a label which
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
        outputIdx.splice(i, 1);
        i--;
        changed = true;
      }
    }

    // Pass 4: Dead label elimination.
    // Remove labels that are not referenced by any JMP/JEQ/JNE/JGT/JLT instruction.
    const referencedLabels = new Set<string>();
    for (const line of output) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith(';') || trimmed.endsWith(':')) continue;
      const tokens = trimmed.split(/\s+/);
      const op = tokens[0];
      if (op === 'JMP' && tokens[1]) {
        referencedLabels.add(tokens[1]);
      } else if ((op === 'JEQ' || op === 'JNE' || op === 'JGT' || op === 'JLT') && tokens[3]) {
        referencedLabels.add(tokens[3]);
      }
    }
    const before = output.length;
    const filteredLines: string[] = [];
    const filteredIdx: number[] = [];
    for (let i = 0; i < output.length; i++) {
      const trimmed = output[i].trim();
      if (trimmed.endsWith(':') && !referencedLabels.has(trimmed.slice(0, -1))) continue;
      filteredLines.push(output[i]);
      filteredIdx.push(outputIdx[i]);
    }
    if (filteredLines.length !== before) {
      changed = true;
    }
    output = filteredLines;
    outputIdx = filteredIdx;
  }

  // ── Final pass: Short-block inlining (runs once, after fixed-point) ──
  // When a JMP targets a block with exactly 2 instructions (non-JMP + JMP),
  // inline the block's body in place of the JMP.  This eliminates one
  // runtime JMP at the cost of slightly larger code — beneficial because the
  // ISA has a 64-op-per-tick budget and no program-size limit.
  //
  // This pass runs outside the fixed-point loop to avoid oscillating with
  // tail merging (tail merge extracts shared tails; inlining undoes sharing;
  // tail merge would re-extract; etc.).
  //
  // Only unconditional JMPs are rewritten.  After inlining, we run a
  // cleanup loop to remove redundant JMPs and dead labels created by
  // the inlining (e.g. if all references to a block were inlined, the
  // block becomes dead).
  {
    const blocks = parseBlocks(output);
    const inlineTargets = new Map<string, { body: string[]; bodyIdx: number[] }>();

    // Build a label→line-index map so we can check the preceding instruction
    const labelLineIdx = new Map<string, number>();
    for (let i = 0; i < output.length; i++) {
      const t = output[i].trim();
      if (t.endsWith(':')) labelLineIdx.set(t.slice(0, -1), i);
    }

    for (const block of blocks) {
      if (block.labels.length === 0) continue;
      if (block.body.length !== 2) continue;
      const lastInstr = block.body[block.body.length - 1];
      if (!lastInstr.startsWith('JMP ')) continue;
      // Don't inline if the JMP target is one of this block's own labels
      const jmpTarget = lastInstr.split(/\s+/)[1];
      if (block.labels.includes(jmpTarget)) continue;

      // Only inline if the block is NOT reachable by fall-through.
      // Check the instruction immediately before the block's first label.
      // If it's an unconditional JMP, the block is only reachable via jumps
      // to its label, so after inlining all JMP refs the block becomes dead.
      const firstLabelLine = labelLineIdx.get(block.labels[0]);
      if (firstLabelLine !== undefined) {
        let prevIsJmp = false;
        for (let p = firstLabelLine - 1; p >= 0; p--) {
          const prev = output[p].trim();
          if (prev === '' || prev.startsWith(';')) continue;
          if (prev.endsWith(':')) continue; // skip adjacent labels
          prevIsJmp = prev.startsWith('JMP ');
          break;
        }
        if (!prevIsJmp) continue; // reachable by fall-through → don't inline
      }

      const bodyIdx = block.bodyLines.map(li => outputIdx[li]);
      for (const lbl of block.labels) {
        inlineTargets.set(lbl, { body: block.body, bodyIdx });
      }
    }

    if (inlineTargets.size > 0) {
      let inlined = false;
      for (let i = 0; i < output.length; i++) {
        const trimmed = output[i].trim();
        if (!trimmed.startsWith('JMP ')) continue;
        const target = trimmed.split(/\s+/)[1];
        const inline = inlineTargets.get(target);
        if (!inline) continue;

        // Replace this JMP with the inlined body
        const newLines = inline.body.map(b => `  ${b}`);
        const newIdx = [...inline.bodyIdx];
        output.splice(i, 1, ...newLines);
        outputIdx.splice(i, 1, ...newIdx);
        inlined = true;
        // Skip past the inlined instructions
        i += newLines.length - 1;
      }

      // Cleanup: remove dead code, redundant JMPs, and dead labels
      if (inlined) {
        let cleanChanged = true;
        while (cleanChanged) {
          cleanChanged = false;

          // Remove unreachable code after unconditional JMP.
          // Note: MOVE, PICKUP, DROP are tick-ending actions but execution
          // continues from the next instruction on the following tick, so
          // code after them IS reachable.
          {
            let i = 0;
            while (i < output.length) {
              const trimmed = output[i].trim();
              if (trimmed.startsWith('JMP ')) {
                let j = i + 1;
                while (j < output.length) {
                  const next = output[j].trim();
                  if (next === '' || next.startsWith(';')) { j++; continue; }
                  if (next.endsWith(':')) break;
                  output.splice(j, 1);
                  outputIdx.splice(j, 1);
                  cleanChanged = true;
                }
              }
              i++;
            }
          }

          // Remove redundant JMPs that fall through to their target
          for (let i = 0; i < output.length; i++) {
            const line = output[i].trim();
            if (!line.startsWith('JMP ')) continue;
            const target = line.split(/\s+/)[1];
            let redundant = false;
            for (let j = i + 1; j < output.length; j++) {
              const next = output[j].trim();
              if (next === '') continue;
              if (next.endsWith(':')) {
                if (next.slice(0, -1) === target) { redundant = true; break; }
                continue;
              }
              break;
            }
            if (redundant) {
              output.splice(i, 1);
              outputIdx.splice(i, 1);
              i--;
              cleanChanged = true;
            }
          }

          // Remove dead labels AND their unreachable block bodies.
          // A dead label's block is unreachable if the instruction preceding
          // the label is an unconditional JMP (no fall-through).  In that case,
          // remove the label and all body instructions until the next label.
          // If the block IS reachable by fall-through, only remove the label.
          const refs = new Set<string>();
          for (const line of output) {
            const t = line.trim();
            if (t === '' || t.startsWith(';') || t.endsWith(':')) continue;
            const tokens = t.split(/\s+/);
            const op = tokens[0];
            if (op === 'JMP' && tokens[1]) refs.add(tokens[1]);
            else if (JUMP_OPS.has(op) && tokens[3]) refs.add(tokens[3]);
          }
          const beforeLen = output.length;
          const filt: string[] = [];
          const filtI: number[] = [];
          for (let i = 0; i < output.length; i++) {
            const t = output[i].trim();
            if (t.endsWith(':') && !refs.has(t.slice(0, -1))) {
              // Dead label. Check if reachable by fall-through.
              // Find the last real instruction before this label.
              let prevIsJmp = false;
              for (let p = filt.length - 1; p >= 0; p--) {
                const prev = filt[p].trim();
                if (prev === '' || prev.startsWith(';')) continue;
                if (prev.endsWith(':')) continue; // skip other labels
                prevIsJmp = prev.startsWith('JMP ');
                break;
              }
              if (prevIsJmp) {
                // Block is unreachable — skip label AND body instructions
                // until the next label or EOF.
                i++; // skip the label line (already not pushed)
                while (i < output.length) {
                  const next = output[i].trim();
                  if (next === '' || next.startsWith(';')) { i++; continue; }
                  if (next.endsWith(':')) { i--; break; } // back up; outer loop will handle this label
                  i++; // skip this body instruction
                  cleanChanged = true;
                }
                cleanChanged = true;
                continue;
              }
              // Reachable by fall-through — just remove the dead label
              cleanChanged = true;
              continue;
            }
            filt.push(output[i]);
            filtI.push(outputIdx[i]);
          }
          if (filt.length !== beforeLen) cleanChanged = true;
          output = filt;
          outputIdx = filtI;
        }
      }
    }
  }

  return { lines: output, instrIndex: outputIdx };
}
