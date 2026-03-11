// ═══════════════════════════════════════════════════════════════
// AntLisp Pipeline — Phase 2: Metadata Collection
// ═══════════════════════════════════════════════════════════════

import { ASTNode } from './parse';

// ─── Types ──────────────────────────────────────────────────

export interface TagDef {
  name: string;
  id: number;
}

export interface Metadata {
  tags: TagDef[];
  forms: ASTNode[];   // remaining forms
}

// ─── Collection ─────────────────────────────────────────────

function collectTagsFromNode(node: ASTNode, seen: Set<string>, tags: TagDef[]): void {
  if (node.type !== 'list' || node.value.length === 0) return;
  const head = node.value[0];
  if (head.type === 'symbol' && head.value === 'set-tag') {
    if (node.value.length > 1 && node.value[1].type === 'symbol') {
      const tagName = node.value[1].value;
      if (!seen.has(tagName) && tags.findIndex(t => t.name === tagName) === -1) {
        seen.add(tagName);
        const id = tags.length;
        if (id < 8) {
          tags.push({ name: tagName, id });
        }
      }
    }
  }
  // Recurse into all sub-expressions (including child 0, which may be a
  // nested list rather than a simple head symbol — e.g. let binding pairs)
  for (let i = 0; i < node.value.length; i++) {
    collectTagsFromNode(node.value[i], seen, tags);
  }
}

export function collectMetadata(forms: ASTNode[]): Metadata {
  const tags: TagDef[] = [];
  const seen = new Set<string>();
  const remaining: ASTNode[] = [];

  for (const form of forms) {
    // Collect tags from set-tag calls
    collectTagsFromNode(form, seen, tags);
    remaining.push(form);
  }

  return { tags, forms: remaining };
}
