// ═══════════════════════════════════════════════════════════════
// AntLisp Pipeline — Tokenizer + Parser + AST Types
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

export interface ParseOptions {
  source?: string;
  sourceFile?: string;
}

export class ParseDiagnosticError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseDiagnosticError';
  }
}

function formatSourceBlock(
  source: string | undefined,
  filename: string | undefined,
  line: number,
  col: number,
  caretMsg: string
): string {
  const file = filename ?? '<input>';
  const gutterWidth = Math.max(2, String(line).length);
  const arrow = `  --> ${file}:${line}:${col}`;
  if (!source) return arrow;

  const sourceLine = source.split('\n')[line - 1] ?? '';
  const gutter = String(line).padStart(gutterWidth);
  const blank = ' '.repeat(gutterWidth);
  const caret = ' '.repeat(col - 1) + '^ ' + caretMsg;
  return [
    arrow,
    `${blank} |`,
    `${gutter} | ${sourceLine}`,
    `${blank} | ${caret}`,
  ].join('\n');
}

export function parse(tokens: Token[], opts?: ParseOptions): Program {
  const source = opts?.source;
  const sourceFile = opts?.sourceFile;
  let pos = 0;

  const unclosedParens: Array<{ tok: Token; formName: string | null }> = [];

  function parseExpr(): ASTNode {
    if (pos >= tokens.length) throw new Error('Unexpected end of input');
    const tok = tokens[pos];
    if (tok.type === 'paren' && tok.value === '(') {
      const startTok = tok;
      pos++;
      // Peek at the next token to capture the form name (e.g. defn, let, if)
      const formName = (pos < tokens.length && tokens[pos].type === 'symbol')
        ? tokens[pos].value as string
        : null;
      const list: ASTNode[] = [];
      while (pos < tokens.length && !(tokens[pos].type === 'paren' && tokens[pos].value === ')')) {
        list.push(parseExpr());
      }
      if (pos >= tokens.length) {
        // Collect this unclosed paren; return a dummy node and let the top-level loop handle reporting
        unclosedParens.push({ tok: startTok, formName });
        return { type: 'list', value: list, line: startTok.line, col: startTok.col };
      }
      pos++;
      return { type: 'list', value: list, line: startTok.line, col: startTok.col };
    }
    if (tok.type === 'paren' && tok.value === ')') {
      const block = formatSourceBlock(source, sourceFile, tok.line, tok.col, 'this `)` has no matching `(`');
      const msg = [
        'unexpected `)`',
        '',
        block,
        '',
        '   = help: remove this `)`',
      ].join('\n');
      throw new ParseDiagnosticError(msg);
    }
    pos++;
    if (tok.type === 'number') return { type: 'number', value: tok.value as number, line: tok.line, col: tok.col };
    if (tok.type === 'string') return { type: 'string', value: tok.value as string, line: tok.line, col: tok.col };
    return { type: 'symbol', value: tok.value as string, line: tok.line, col: tok.col };
  }

  const program: ASTNode[] = [];
  while (pos < tokens.length) program.push(parseExpr());

  if (unclosedParens.length > 0) {
    const n = unclosedParens.length;
    const header = n === 1 ? 'unclosed expression' : `${n} unclosed expressions`;
    const parts: string[] = [header, ''];

    for (const { tok, formName: _ } of unclosedParens) {
      parts.push(formatSourceBlock(source, sourceFile, tok.line, tok.col, 'opened here, never closed'));
      parts.push('');
    }

    if (n === 1) {
      const { formName } = unclosedParens[0];
      if (formName) {
        parts.push(`   = note: reached end of file while parsing body of \`${formName}\``);
      }
      parts.push(`   = help: add 1 closing \`)\` before end of file`);
    } else {
      // Multiple: list inside-out (innermost first → reversed array is outermost-first, we want innermost close first)
      const helpParts = [...unclosedParens].reverse().map(({ tok, formName }) => {
        const name = formName ? `\`${formName}\`` : 'expression';
        return `\`)\` to close ${name} (line ${tok.line})`;
      });
      parts.push(`   = help: add ${helpParts.join(', then ')}`);
    }

    throw new ParseDiagnosticError(parts.join('\n'));
  }

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
