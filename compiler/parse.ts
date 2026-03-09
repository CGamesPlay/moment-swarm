// ═══════════════════════════════════════════════════════════════
// AntLisp v2 Pipeline — Tokenizer + Parser + AST Types
// ═══════════════════════════════════════════════════════════════

// ─── AST Types ──────────────────────────────────────────────

export interface SourceLoc {
  line: number;
  col: number;
}

export interface NumberNode extends SourceLoc {
  type: 'number';
  value: number;
}

export interface StringNode extends SourceLoc {
  type: 'string';
  value: string;
}

export interface SymbolNode extends SourceLoc {
  type: 'symbol';
  value: string;
}

export interface ListNode extends SourceLoc {
  type: 'list';
  value: ASTNode[];
}

export type ASTNode = NumberNode | StringNode | SymbolNode | ListNode;

export interface Program {
  type: 'program';
  body: ASTNode[];
}

// ─── Token Types ────────────────────────────────────────────

export interface Token {
  type: 'paren' | 'number' | 'string' | 'symbol';
  value: string | number;
  pos: number;
  line: number;
  col: number;
}

// ─── TOKENIZER ──────────────────────────────────────────────

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;

  while (i < source.length) {
    const ch = source[i];
    if (ch === '\n') { line++; col = 1; i++; continue; }
    if (/\s/.test(ch)) { col++; i++; continue; }
    if (ch === ';') {
      while (i < source.length && source[i] !== '\n') { i++; col++; }
      continue;
    }
    if (ch === '(' || ch === ')') {
      tokens.push({ type: 'paren', value: ch, pos: i, line, col });
      i++; col++; continue;
    }
    if (ch === '"') {
      const startPos = i;
      const startLine = line, startCol = col;
      let str = '';
      i++; col++;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\n') { line++; col = 1; } else { col++; }
        str += source[i]; i++;
      }
      i++; col++;
      tokens.push({ type: 'string', value: str, pos: startPos, line: startLine, col: startCol });
      continue;
    }
    // Hex literals 0xFF
    if (ch === '0' && i + 1 < source.length && source[i + 1] === 'x') {
      const startPos = i;
      const startLine = line, startCol = col;
      let hex = '';
      i += 2; col += 2;
      while (i < source.length && /[0-9a-fA-F]/.test(source[i])) { hex += source[i]; i++; col++; }
      tokens.push({ type: 'number', value: parseInt(hex, 16), pos: startPos, line: startLine, col: startCol });
      continue;
    }
    // Numbers (including negative)
    if (/[0-9]/.test(ch) || (ch === '-' && i + 1 < source.length && /[0-9]/.test(source[i + 1]))) {
      const startPos = i;
      const startLine = line, startCol = col;
      let num = '';
      if (ch === '-') { num = '-'; i++; col++; }
      while (i < source.length && /[0-9]/.test(source[i])) { num += source[i]; i++; col++; }
      tokens.push({ type: 'number', value: parseInt(num, 10), pos: startPos, line: startLine, col: startCol });
      continue;
    }
    // Symbols
    if (/[^\s();"]/.test(ch)) {
      const startPos = i;
      const startLine = line, startCol = col;
      let sym = '';
      while (i < source.length && /[^\s();"]/.test(source[i])) { sym += source[i]; i++; col++; }
      tokens.push({ type: 'symbol', value: sym, pos: startPos, line: startLine, col: startCol });
      continue;
    }
    i++; col++;
  }
  return tokens;
}

// ─── PARSER ─────────────────────────────────────────────────

export function parse(tokens: Token[]): Program {
  let pos = 0;

  function parseExpr(): ASTNode {
    if (pos >= tokens.length) throw new Error('Unexpected end of input');
    const tok = tokens[pos];
    if (tok.type === 'paren' && tok.value === '(') {
      const startTok = tok;
      pos++;
      const list: ASTNode[] = [];
      while (pos < tokens.length && !(tokens[pos].type === 'paren' && tokens[pos].value === ')')) {
        list.push(parseExpr());
      }
      if (pos >= tokens.length) throw new Error(`Missing closing paren for ( at line ${startTok.line}:${startTok.col}`);
      pos++;
      return { type: 'list', value: list, line: startTok.line, col: startTok.col };
    }
    if (tok.type === 'paren' && tok.value === ')') {
      throw new Error(`Unexpected ) at line ${tok.line}:${tok.col}`);
    }
    pos++;
    if (tok.type === 'number') return { type: 'number', value: tok.value as number, line: tok.line, col: tok.col };
    if (tok.type === 'string') return { type: 'string', value: tok.value as string, line: tok.line, col: tok.col };
    return { type: 'symbol', value: tok.value as string, line: tok.line, col: tok.col };
  }

  const program: ASTNode[] = [];
  while (pos < tokens.length) program.push(parseExpr());
  return { type: 'program', body: program };
}

// ─── AST Utilities ──────────────────────────────────────────

export function cloneAST(node: ASTNode): ASTNode {
  if (node.type === 'list') {
    return {
      type: 'list',
      value: node.value.map(c => cloneAST(c)),
      line: node.line, col: node.col
    };
  }
  return { ...node };
}

export function astToSource(node: ASTNode): string {
  if (node.type === 'number') return String(node.value);
  if (node.type === 'string') return `"${node.value}"`;
  if (node.type === 'symbol') return node.value;
  if (node.type === 'list') return '(' + node.value.map(astToSource).join(' ') + ')';
  return '';
}
