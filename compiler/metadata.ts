// ═══════════════════════════════════════════════════════════════
// AntLisp Pipeline — Phase 2: Metadata Collection
// ═══════════════════════════════════════════════════════════════

import { ASTNode } from './parse';

// ─── Types ──────────────────────────────────────────────────

export interface TagDef {
  name: string;
  id: number;
}

export interface AliasDef {
  name: string;
  reg: string;
}

export interface Metadata {
  tags: TagDef[];
  aliases: AliasDef[];
  forms: ASTNode[];   // forms with alias directives removed
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
  // Recurse into sub-expressions
  for (let i = 1; i < node.value.length; i++) {
    collectTagsFromNode(node.value[i], seen, tags);
  }
}

export function collectMetadata(forms: ASTNode[]): Metadata {
  const tags: TagDef[] = [];
  const aliases: AliasDef[] = [];
  const seen = new Set<string>();
  const remaining: ASTNode[] = [];

  for (const form of forms) {
    // Check for (alias name reg) top-level directive
    if (form.type === 'list' && form.value.length >= 3 &&
        form.value[0].type === 'symbol' && form.value[0].value === 'alias') {
      aliases.push({
        name: (form.value[1] as any).value as string,
        reg: (form.value[2] as any).value as string,
      });
      continue;
    }

    // Collect tags from set-tag calls
    collectTagsFromNode(form, seen, tags);
    remaining.push(form);
  }

  return { tags, aliases, forms: remaining };
}
