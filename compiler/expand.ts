// ═══════════════════════════════════════════════════════════════
// AntLisp Pipeline — Phase 1: Macro Expansion + Const Resolution
// ═══════════════════════════════════════════════════════════════

import { ASTNode, ListNode, cloneAST } from './parse';

// ─── Types ──────────────────────────────────────────────────

export interface MacroDef {
  name: string;
  params: string[];
  body: ASTNode[];
}

export interface ConstDef {
  name: string;
  value: string;  // resolved string value (e.g. "42", "CH_RED")
}

export interface ExpandResult {
  forms: ASTNode[];           // expanded top-level forms (no defmacro, no const)
  constValues: Map<string, string>;  // collected const values
}

// ─── Const Evaluation ───────────────────────────────────────

// Arithmetic ops for compile-time evaluation
const ARITH_OPS: Record<string, (a: number, b: number) => number> = {
  '+': (a, b) => a + b,
  '-': (a, b) => a - b,
  '*': (a, b) => a * b,
  '/': (a, b) => Math.trunc(a / b),
  'mod': (a, b) => a % b,
  'and': (a, b) => a & b,
  'or': (a, b) => a | b,
  'xor': (a, b) => a ^ b,
  'lshift': (a, b) => a << b,
  'rshift': (a, b) => a >> b,
};

// Directions, channels, targets — for resolving const values
function resolveConstAtom(name: string, consts: Map<string, string>): string | null {
  if (consts.has(name)) return consts.get(name)!;
  const lower = name.toLowerCase();
  if (['n', 'e', 's', 'w', 'north', 'east', 'south', 'west', 'random', 'here'].includes(lower)) return name.toUpperCase();
  if (['ch_red', 'ch_blue', 'ch_green', 'ch_yellow'].includes(lower)) return name.toUpperCase();
  if (['food', 'wall', 'nest', 'ant', 'empty'].includes(lower)) return name.toUpperCase();
  if (name === '#t' || name === 'true') return '1';
  if (name === '#f' || name === 'false') return '0';
  return null;
}

// Try to evaluate a node as a compile-time constant integer.
export function tryEvalConst(node: ASTNode, consts: Map<string, string>): number | null {
  if (node.type === 'number') return node.value;
  if (node.type === 'symbol') {
    const resolved = resolveConstAtom(node.value, consts);
    if (resolved === null) return null;
    const n = parseInt(resolved, 10);
    return isNaN(n) ? null : n;
  }
  if (node.type !== 'list') return null;
  const list = node.value;
  if (!list.length) return null;
  if (list[0].type !== 'symbol') return null;
  const op = list[0].value;
  const fn = ARITH_OPS[op];
  if (!fn) return null;
  const args: number[] = [];
  for (let i = 1; i < list.length; i++) {
    const v = tryEvalConst(list[i], consts);
    if (v === null) return null;
    args.push(v);
  }
  if (args.length === 0) return null;
  if (args.length === 1 && op === '-') return -args[0];
  if (args.length === 1) return args[0];
  return args.reduce(fn);
}

// Resolve a const value node to a string
function resolveConstValue(node: ASTNode, consts: Map<string, string>): string {
  if (node.type === 'list') {
    const n = tryEvalConst(node, consts);
    if (n === null) throw new Error(`const value is not a compile-time constant at line ${node.line}:${node.col}`);
    return String(n);
  }
  if (node.type === 'number') return String(node.value);
  if (node.type === 'symbol') {
    const resolved = resolveConstAtom(node.value, consts);
    if (resolved !== null) return resolved;
    return node.value.toUpperCase();
  }
  return String(node.value);
}

// ─── Macro Substitution ─────────────────────────────────────

// Replace parameter symbols with the caller's AST nodes.
// Handles the splicing case: (param) where param substitutes to a list
// becomes just the substituted list (not ((list...))).
function substituteParams(node: ASTNode, substitutions: Map<string, ASTNode>): ASTNode {
  if (node.type === 'symbol' && substitutions.has(node.value)) {
    return cloneAST(substitutions.get(node.value)!);
  }
  if (node.type === 'list') {
    const children = node.value;
    // Splice case: (param) where param → list becomes just the list
    if (children.length === 1
        && children[0].type === 'symbol'
        && substitutions.has(children[0].value)) {
      const sub = substitutions.get(children[0].value)!;
      return cloneAST(sub);
    }
    return {
      type: 'list',
      value: children.map(child => substituteParams(child, substitutions)),
      line: node.line, col: node.col
    };
  }
  return node;
}

// Recursively freshen AST nodes for macro expansion.
// tagbody/go labels are freshened by the lowering phase, not here.
function freshenLabels(node: ASTNode, _labelPrefix: string): ASTNode {
  if (node.type !== 'list') return node;
  const list = (node as ListNode).value;
  if (list.length === 0) return node;
  return {
    type: 'list',
    value: list.map(child => freshenLabels(child, _labelPrefix)),
    line: node.line,
    col: node.col
  };
}

// ─── Const Substitution in AST ──────────────────────────────

function substituteConsts(node: ASTNode, consts: Map<string, string>): ASTNode {
  if (node.type === 'symbol' && consts.has(node.value)) {
    const val = consts.get(node.value)!;
    const n = parseInt(val, 10);
    if (!isNaN(n) && String(n) === val) {
      return { type: 'number', value: n, line: node.line, col: node.col };
    }
    return { type: 'symbol', value: val, line: node.line, col: node.col };
  }
  if (node.type === 'list') {
    return {
      type: 'list',
      value: node.value.map(child => substituteConsts(child, consts)),
      line: node.line, col: node.col
    };
  }
  return node;
}

// ─── Macro Expansion in AST ─────────────────────────────────

let expansionCounter = 0;

function expandNode(
  node: ASTNode,
  macros: Map<string, MacroDef>,
  consts: Map<string, string>,
  depth: number
): ASTNode {
  if (depth > 100) throw new Error('Macro expansion depth limit exceeded (>100)');

  if (node.type !== 'list') {
    // Substitute consts for symbols
    return substituteConsts(node, consts);
  }

  const list = node.value;
  if (list.length === 0) return node;

  const head = list[0];
  if (head.type === 'symbol' && macros.has(head.value)) {
    const macro = macros.get(head.value)!;
    const args = list.slice(1);
    if (macro.params.length !== args.length) {
      throw new Error(`Macro ${head.value} expects ${macro.params.length} args, got ${args.length} at line ${node.line}:${node.col}`);
    }

    // Build substitution map
    const substitutions = new Map<string, ASTNode>();
    for (let i = 0; i < macro.params.length; i++) {
      substitutions.set(macro.params[i], args[i]);
    }

    // Substitute, freshen, wrap in begin if multi-form
    const prefix = `__${head.value}_${expansionCounter++}`;
    const expandedBody = macro.body.map(n => {
      const substituted = substituteParams(n, substitutions);
      return freshenLabels(substituted, prefix);
    });

    // Wrap multi-form body in (begin ...)
    let result: ASTNode;
    if (expandedBody.length === 1) {
      result = expandedBody[0];
    } else {
      result = {
        type: 'list',
        value: [{ type: 'symbol', value: 'begin', line: node.line, col: node.col }, ...expandedBody],
        line: node.line, col: node.col
      };
    }

    // Recursively expand the result (macros can produce more macro calls)
    return expandNode(result, macros, consts, depth + 1);
  }

  // Not a macro call — recurse into children
  return {
    type: 'list',
    value: list.map(child => expandNode(child, macros, consts, depth)),
    line: node.line, col: node.col
  };
}

// ─── Public API ─────────────────────────────────────────────

export interface ExpandOptions {
  constOverrides?: Map<string, string>;
}

export function expandMacros(forms: ASTNode[], options: ExpandOptions = {}): ExpandResult {
  const macros = new Map<string, MacroDef>();
  const consts = new Map<string, string>();
  const remaining: ASTNode[] = [];

  // Reset expansion counter for deterministic output
  expansionCounter = 0;

  // Pass 1: Collect defmacro and const definitions, keep other forms
  for (const form of forms) {
    if (form.type !== 'list' || form.value.length === 0) {
      remaining.push(form);
      continue;
    }
    const head = form.value[0];
    if (head.type !== 'symbol') {
      remaining.push(form);
      continue;
    }

    if (head.value === 'defmacro') {
      const list = form.value;
      const name = (list[1] as any).value as string;
      const params = (list[2] as ListNode).value.map((p: ASTNode) => (p as any).value as string);
      const body = list.slice(3);
      macros.set(name, { name, params, body });
    } else if (head.value === 'const') {
      const list = form.value;
      const name = (list[1] as any).value as string;
      if (options.constOverrides?.has(name)) {
        const rawVal = options.constOverrides.get(name)!;
        const isNum = rawVal !== '' && !isNaN(Number(rawVal));
        const valNode: ASTNode = isNum
          ? { type: 'number', value: Number(rawVal), line: form.line, col: form.col }
          : { type: 'symbol', value: rawVal, line: form.line, col: form.col };
        const resolved = resolveConstValue(valNode, consts);
        consts.set(name, resolved);
      } else {
        const value = resolveConstValue(list[2], consts);
        consts.set(name, value);
      }
    } else {
      remaining.push(form);
    }
  }

  // Pass 2: Expand macros and substitute consts in remaining forms
  const expanded = remaining.map(form => expandNode(form, macros, consts, 0));

  return { forms: expanded, constValues: consts };
}
