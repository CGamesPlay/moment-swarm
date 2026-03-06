// ═══════════════════════════════════════════════════════════════
// AntLisp v2 — S-Expression Compiler for Antssembly
// ═══════════════════════════════════════════════════════════════
//
// Changes from v1:
//  - (define var expr) at top level creates GLOBALS
//  - (define var expr :reg rN) pins a global to a specific register
//  - Smarter register allocation: globals are permanently reserved

// ─── TOKENIZER ───────────────────────────────────────────────

function tokenize(source) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let col = 1;
  let lineStart = 0;  // character index where current line starts
  
  function makePos(startIdx) {
    // Calculate line/col for a given character index
    let l = 1, c = 1, ls = 0;
    for (let j = 0; j < startIdx; j++) {
      if (source[j] === '\n') { l++; c = 1; ls = j + 1; }
      else { c++; }
    }
    return { line: l, col: c, pos: startIdx };
  }
  
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\n') { line++; col = 1; lineStart = i + 1; i++; continue; }
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

// ─── PARSER ──────────────────────────────────────────────────

function parse(tokens) {
  let pos = 0;
  function parseExpr() {
    if (pos >= tokens.length) throw new Error('Unexpected end of input');
    const tok = tokens[pos];
    if (tok.type === 'paren' && tok.value === '(') {
      const startTok = tok;  // remember opening paren for location
      pos++;
      const list = [];
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
    if (tok.type === 'number') return { type: 'number', value: tok.value, line: tok.line, col: tok.col };
    if (tok.type === 'string') return { type: 'string', value: tok.value, line: tok.line, col: tok.col };
    return { type: 'symbol', value: tok.value, line: tok.line, col: tok.col };
  }
  const program = [];
  while (pos < tokens.length) program.push(parseExpr());
  return { type: 'program', body: program };
}

// ─── COMPILER ────────────────────────────────────────────────

class Compiler {
  constructor() {
    this.output = [];
    this.labelCounter = 0;
    this.usedRegs = new Set();     // registers currently in use
    this.bindings = new Map();     // variable name -> register string
    this.globals = new Map();      // global variable name -> register string
    this.roles = [];
    this.aliases = [];
    this.constants = [];
    this.loopStack = [];
    this.currentNode = null;       // track current AST node for error messages
    this.nodeStack = [];           // stack of nodes for context
  }

  // Format location info for error messages
  locInfo(node) {
    if (node && node.line !== undefined) {
      return `line ${node.line}:${node.col}`;
    }
    return 'unknown location';
  }

  // Create an error with location context
  errorAt(message, node) {
    const loc = node || this.currentNode;
    const locStr = this.locInfo(loc);
    
    // Build context from node stack
    let context = '';
    if (this.nodeStack.length > 0) {
      const contextNodes = this.nodeStack.slice(-3);  // last 3 nodes
      context = '\n  in: ' + contextNodes.map(n => {
        if (n.type === 'list' && n.value.length > 0 && n.value[0].type === 'symbol') {
          return `(${n.value[0].value} ...) at ${this.locInfo(n)}`;
        }
        return `${n.type} at ${this.locInfo(n)}`;
      }).join('\n    → ');
    }
    
    return new CompileError(`${message}\n  at ${locStr}${context}`);
  }

  // Push/pop node context for tracking
  pushNode(node) {
    this.nodeStack.push(node);
    this.currentNode = node;
  }

  popNode() {
    this.nodeStack.pop();
    this.currentNode = this.nodeStack[this.nodeStack.length - 1] || null;
  }

  freshLabel(hint = 'L') {
    return `__${hint}_${this.labelCounter++}`;
  }

  // ── Register Allocation ──

  allocReg() {
    for (let i = 0; i <= 7; i++) {
      if (!this.usedRegs.has(i)) {
        this.usedRegs.add(i);
        return `r${i}`;
      }
    }
    const inUse = [...this.usedRegs].sort().map(r => `r${r}`).join(', ');
    throw this.errorAt(`Register exhaustion — all registers in use (currently: ${inUse}). Reduce nesting or free variables.`);
  }

  allocSpecificReg(n) {
    if (this.usedRegs.has(n)) {
      throw this.errorAt(`Register r${n} is already allocated`);
    }
    this.usedRegs.add(n);
    return `r${n}`;
  }

  freeReg(reg) {
    const idx = parseInt(reg.slice(1));
    this.usedRegs.delete(idx);
  }

  isRegInUse(n) {
    return this.usedRegs.has(n);
  }

  emit(line) { this.output.push(line); }
  emitLabel(label) { this.output.push(`${label}:`); }
  emitComment(text) { this.output.push(`  ; ${text}`); }

  // ── Atom resolution ──

  isDirection(s) {
    return ['n', 'e', 's', 'w', 'north', 'east', 'south', 'west', 'random', 'here'].includes(s.toLowerCase());
  }
  isChannel(s) {
    return ['ch_red', 'ch_blue', 'ch_green', 'ch_yellow'].includes(s.toLowerCase());
  }
  isTarget(s) {
    return ['food', 'wall', 'nest', 'ant', 'empty'].includes(s.toLowerCase());
  }

  resolveAtom(node) {
    if (node.type === 'number') return String(node.value);
    if (node.type === 'symbol') {
      const name = node.value;
      if (this.bindings.has(name)) return this.bindings.get(name);
      if (this.globals.has(name)) return this.globals.get(name);
      if (this.isDirection(name)) return name.toUpperCase();
      if (this.isChannel(name)) return name.toUpperCase();
      if (this.isTarget(name)) return name.toUpperCase();
      if (name === '#t' || name === 'true') return '1';
      if (name === '#f' || name === 'false') return '0';
      const role = this.roles.find(r => r.name === name);
      if (role) return String(role.id);
      return name.toUpperCase();
    }
    throw this.errorAt(`Cannot resolve: ${JSON.stringify(node)}`, node);
  }

  // resolveArg: like resolveAtom but handles compound expressions
  // by compiling them into a temp register. Returns { val, tempReg }
  // where tempReg is set if a register was allocated (caller must free).
  resolveArg(node) {
    if (node.type === 'number' || node.type === 'symbol') {
      return { val: this.resolveAtom(node), tempReg: null };
    }
    // Compound expression — compile into a temp register
    const reg = this.allocReg();
    this.compileExpr(node, reg);
    return { val: reg, tempReg: reg };
  }

  // ── Compilation entry ──

  compile(ast) {
    // Pass 1: collect metadata
    for (const node of ast.body) {
      if (node.type === 'list' && node.value.length > 0) {
        const head = node.value[0];
        if (head.type === 'symbol') {
          if (head.value === 'define-role') this.collectRole(node.value);
        }
      }
    }

    // Emit directives
    for (const r of this.roles) this.emit(`.tag ${r.id} ${r.name}`);
    for (const a of this.aliases) this.emit(`.alias ${a.name} ${a.reg}`);
    for (const c of this.constants) this.emit(`.const ${c.name} ${c.value}`);
    if (this.roles.length || this.aliases.length || this.constants.length) this.emit('');

    // Pass 2: compile
    for (const node of ast.body) {
      this.compileTopLevel(node);
    }

    return this.output.join('\n');
  }

  collectRole(list) {
    this.roles.push({ name: list[1].value, id: list[2].value });
  }

  compileTopLevel(node) {
    if (node.type !== 'list' || node.value.length === 0) return;
    const head = node.value[0];
    if (head.type !== 'symbol') { this.compileExpr(node); return; }

    switch (head.value) {
      case 'define-role': return; // already collected, no code emission unless it has a body
      case 'define':      return this.compileGlobalDefine(node.value);
      case 'alias':       return this.compileAlias(node.value);
      case 'const':       return this.compileConst(node.value);
      case 'main':        return this.compileMain(node.value);
      default:            this.compileExpr(node);
    }
  }

  // ── (define var expr) or (define var expr :reg rN) ──
  // Top-level defines create globals with permanently reserved registers
  compileGlobalDefine(list) {
    const name = list[1].value;
    let reg;

    // Check for :reg annotation: (define var expr :reg r3)
    const regAnnotIdx = list.findIndex((n, i) => i >= 2 && n.type === 'symbol' && n.value === ':reg');
    if (regAnnotIdx !== -1) {
      const regName = list[regAnnotIdx + 1].value;
      const regNum = parseInt(regName.slice(1));
      reg = this.allocSpecificReg(regNum);
    } else {
      reg = this.allocReg();
    }

    this.globals.set(name, reg);
    this.bindings.set(name, reg);

    // Find init expression (skip :reg annotation)
    const initExpr = list.length > 2 && list[2].type !== 'symbol' ? list[2] :
                     list.length > 2 && list[2].value !== ':reg' ? list[2] : null;
    if (initExpr) {
      this.compileInto(initExpr, reg);
    } else {
      // default to 0 if no init
      this.emit(`  SET ${reg} 0`);
    }
  }

  // ── (main body...) ──
  compileMain(list) {
    this.emitLabel('main');
    for (let i = 1; i < list.length; i++) this.compileExpr(list[i]);
  }

  // ── (alias name reg) ──
  compileAlias(list) {
    this.aliases.push({ name: list[1].value, reg: list[2].value });
  }

  // ── (const name value) ──
  compileConst(list) {
    this.constants.push({ name: list[1].value, value: this.resolveAtom(list[2]) });
  }

  // ── Expression compiler ──

  compileExpr(node, destReg = null) {
    this.pushNode(node);  // Track current node for error messages
    try {
      return this._compileExprInner(node, destReg);
    } finally {
      this.popNode();
    }
  }

  _compileExprInner(node, destReg) {
    if (node.type === 'number' || (node.type === 'symbol' && node.type !== 'list')) {
      if (destReg) {
        const val = this.resolveAtom(node);
        if (val !== destReg) this.emit(`  SET ${destReg} ${val}`);
        return destReg;
      }
      return this.resolveAtom(node);
    }

    if (node.type !== 'list') return this.resolveAtom(node);
    const list = node.value;
    if (list.length === 0) return null;
    const head = list[0];
    if (head.type !== 'symbol') throw this.errorAt(`Expected symbol at head, got ${head.type}`);
    const op = head.value;

    switch (op) {
      case 'if':       return this.compileIf(list, destReg);
      case 'when':     return this.compileWhen(list);
      case 'unless':   return this.compileUnless(list);
      case 'cond':     return this.compileCond(list, destReg);
      case 'begin':    return this.compileBegin(list, destReg);
      case 'loop':     return this.compileLoop(list);
      case 'while':    return this.compileWhile(list);
      case 'dotimes':  return this.compileDotimes(list);
      case 'break':    return this.compileBreak();
      case 'continue': return this.compileContinue();
      case 'goto':     this.emit(`  JMP ${list[1].value}`); return null;
      case 'label':    this.emitLabel(list[1].value); return null;

      case 'let':      return this.compileLet(list, destReg);
      case 'set!':     return this.compileSet(list);

      case 'sense':    return this.compileSenseOp('SENSE', list, destReg);
      case 'smell':    return this.compileSenseOp('SMELL', list, destReg);
      case 'probe':    return this.compileSenseOp('PROBE', list, destReg);
      case 'sniff':    return this.compileSniff(list, destReg);
      case 'carrying?':return this.compileNullaryOp('CARRYING', destReg);
      case 'id':       return this.compileNullaryOp('ID', destReg);

      case 'move': {
        const a = this.resolveArg(list[1]);
        this.emit(`  MOVE ${a.val}`);
        if (a.tempReg) this.freeReg(a.tempReg);
        return null;
      }
      case 'pickup':   this.emit('  PICKUP'); return null;
      case 'drop':     this.emit('  DROP'); return null;
      case 'mark': {
        const ch = this.resolveArg(list[1]);
        const amt = this.resolveArg(list[2]);
        this.emit(`  MARK ${ch.val} ${amt.val}`);
        if (ch.tempReg) this.freeReg(ch.tempReg);
        if (amt.tempReg) this.freeReg(amt.tempReg);
        return null;
      }
      case 'tag': {
        const t = this.resolveArg(list[1]);
        this.emit(`  TAG ${t.val}`);
        if (t.tempReg) this.freeReg(t.tempReg);
        return null;
      }

      case '=': case '!=': case '>': case '<': case '>=': case '<=':
      case 'not': case 'zero?':
        return this.compileComparison(list, destReg);

      case '+': case '-': case '*': case '/':
      case 'mod': case 'and': case 'or': case 'xor':
      case 'lshift': case 'rshift': case 'random':
        return this.compileArith(list, destReg);

      case 'dispatch': return this.compileDispatch(list);
      case 'comment':
        if (list.length > 1) this.emitComment(String(list[1].value));
        return null;

      default:
        throw this.errorAt(`Unknown form: ${op}`);
    }
  }

  compileInto(node, destReg) { return this.compileExpr(node, destReg); }

  ensureInReg(node, existingReg = null) {
    if (node.type === 'symbol') {
      const resolved = this.resolveAtom(node);
      if (resolved.startsWith('r')) return { reg: resolved, allocated: false };
    }
    const reg = existingReg || this.allocReg();
    this.compileInto(node, reg);
    return { reg, allocated: !existingReg };
  }

  // ── Helpers for common patterns ──

  compileSenseOp(instr, list, destReg) {
    const target = this.resolveAtom(list[1]);
    const reg = destReg || this.allocReg();
    this.emit(`  ${instr} ${target} ${reg}`);
    return reg;
  }

  compileNullaryOp(instr, destReg) {
    const reg = destReg || this.allocReg();
    this.emit(`  ${instr} ${reg}`);
    return reg;
  }

  compileSniff(list, destReg) {
    const ch = this.resolveAtom(list[1]);
    const dir = this.resolveAtom(list[2]);
    const reg = destReg || this.allocReg();
    this.emit(`  SNIFF ${ch} ${dir} ${reg}`);
    return reg;
  }

  // ── let / set! ──

  compileLet(list, destReg) {
    const bindings = list[1].value;
    const savedBindings = new Map(this.bindings);
    const allocatedRegs = [];

    for (const binding of bindings) {
      const pair = binding.value;
      const name = pair[0].value;
      const reg = this.allocReg();
      allocatedRegs.push(reg);
      this.compileInto(pair[1], reg);
      this.bindings.set(name, reg);
    }

    let result = null;
    for (let i = 2; i < list.length; i++) {
      result = this.compileExpr(list[i], i === list.length - 1 ? destReg : null);
    }

    this.bindings = savedBindings;
    for (const reg of allocatedRegs) this.freeReg(reg);
    return result;
  }

  compileSet(list) {
    const name = list[1].value;
    const reg = this.bindings.get(name) || this.globals.get(name);
    if (!reg) throw this.errorAt(`Undefined variable: ${name}`);
    this.compileInto(list[2], reg);
    return reg;
  }

  // ── if / when / unless / cond / begin ──

  compileIf(list, destReg) {
    const elseLabel = this.freshLabel('else');
    const endLabel = this.freshLabel('endif');
    const hasElse = list.length > 3;
    this.compileCondJump(list[1], elseLabel, true);
    this.compileExpr(list[2], destReg);
    if (hasElse) this.emit(`  JMP ${endLabel}`);
    this.emitLabel(elseLabel);
    if (hasElse) this.compileExpr(list[3], destReg);
    this.emitLabel(endLabel);
    return destReg;
  }

  compileWhen(list) {
    const endLabel = this.freshLabel('endwhen');
    this.compileCondJump(list[1], endLabel, true);
    for (let i = 2; i < list.length; i++) this.compileExpr(list[i]);
    this.emitLabel(endLabel);
    return null;
  }

  compileUnless(list) {
    const endLabel = this.freshLabel('endunless');
    this.compileCondJump(list[1], endLabel, false);
    for (let i = 2; i < list.length; i++) this.compileExpr(list[i]);
    this.emitLabel(endLabel);
    return null;
  }

  compileCond(list, destReg) {
    const endLabel = this.freshLabel('endcond');
    for (let i = 1; i < list.length; i++) {
      const clause = list[i].value;
      const test = clause[0];
      if (test.type === 'symbol' && test.value === 'else') {
        for (let j = 1; j < clause.length; j++)
          this.compileExpr(clause[j], j === clause.length - 1 ? destReg : null);
        break;
      }
      const nextLabel = this.freshLabel('cond_next');
      this.compileCondJump(test, nextLabel, true);
      for (let j = 1; j < clause.length; j++)
        this.compileExpr(clause[j], j === clause.length - 1 ? destReg : null);
      this.emit(`  JMP ${endLabel}`);
      this.emitLabel(nextLabel);
    }
    this.emitLabel(endLabel);
    return destReg;
  }

  compileBegin(list, destReg) {
    let result = null;
    for (let i = 1; i < list.length; i++)
      result = this.compileExpr(list[i], i === list.length - 1 ? destReg : null);
    return result;
  }

  // ── Loops ──

  compileLoop(list) {
    const top = this.freshLabel('loop');
    const end = this.freshLabel('endloop');
    this.loopStack.push({ top, end });
    this.emitLabel(top);
    for (let i = 1; i < list.length; i++) this.compileExpr(list[i]);
    this.emit(`  JMP ${top}`);
    this.emitLabel(end);
    this.loopStack.pop();
    return null;
  }

  compileWhile(list) {
    const top = this.freshLabel('while');
    const end = this.freshLabel('endwhile');
    this.loopStack.push({ top, end });
    this.emitLabel(top);
    this.compileCondJump(list[1], end, true);
    for (let i = 2; i < list.length; i++) this.compileExpr(list[i]);
    this.emit(`  JMP ${top}`);
    this.emitLabel(end);
    this.loopStack.pop();
    return null;
  }

  compileDotimes(list) {
    const pair = list[1].value;
    const varName = pair[0].value;
    const countVal = this.resolveAtom(pair[1]);
    const reg = this.allocReg();
    this.emit(`  SET ${reg} 0`);
    const savedBindings = new Map(this.bindings);
    this.bindings.set(varName, reg);
    const top = this.freshLabel('dotimes');
    const end = this.freshLabel('enddotimes');
    this.loopStack.push({ top, end });
    this.emitLabel(top);
    this.emit(`  JEQ ${reg} ${countVal} ${end}`);
    for (let i = 2; i < list.length; i++) this.compileExpr(list[i]);
    this.emit(`  ADD ${reg} 1`);
    this.emit(`  JMP ${top}`);
    this.emitLabel(end);
    this.loopStack.pop();
    this.bindings = savedBindings;
    this.freeReg(reg);
    return null;
  }

  compileBreak() {
    if (!this.loopStack.length) throw this.errorAt('break outside loop');
    this.emit(`  JMP ${this.loopStack[this.loopStack.length - 1].end}`);
    return null;
  }

  compileContinue() {
    if (!this.loopStack.length) throw this.errorAt('continue outside loop');
    this.emit(`  JMP ${this.loopStack[this.loopStack.length - 1].top}`);
    return null;
  }

  // ── Arithmetic ──

  compileArith(list, destReg) {
    const opMap = {
      '+': 'ADD', '-': 'SUB', '*': 'MUL', '/': 'DIV',
      'mod': 'MOD', 'and': 'AND', 'or': 'OR', 'xor': 'XOR',
      'lshift': 'LSHIFT', 'rshift': 'RSHIFT', 'random': 'RANDOM'
    };
    const op = list[0].value;
    const asmOp = opMap[op];

    if (list.length === 2 && op === '-') {
      const reg = destReg || this.allocReg();
      const a = this.resolveArg(list[1]);
      if (a.val === reg) {
        // Operand is same register as dest — need temp
        const tmp = this.allocReg();
        this.emit(`  SET ${tmp} ${a.val}`);
        this.emit(`  SET ${reg} 0`);
        this.emit(`  SUB ${reg} ${tmp}`);
        this.freeReg(tmp);
      } else {
        this.emit(`  SET ${reg} 0`);
        this.emit(`  SUB ${reg} ${a.val}`);
      }
      if (a.tempReg) this.freeReg(a.tempReg);
      return reg;
    }
    if (list.length === 2 && op === 'random') {
      const reg = destReg || this.allocReg();
      const a = this.resolveArg(list[1]);
      this.emit(`  RANDOM ${reg} ${a.val}`);
      if (a.tempReg) this.freeReg(a.tempReg);
      return reg;
    }

    const reg = destReg || this.allocReg();
    this.compileInto(list[1], reg);
    for (let i = 2; i < list.length; i++) {
      const a = this.resolveArg(list[i]);
      this.emit(`  ${asmOp} ${reg} ${a.val}`);
      if (a.tempReg) this.freeReg(a.tempReg);
    }
    return reg;
  }

  // ── Conditional jumps ──

  compileCondJump(node, label, jumpOnFalse = true) {
    if (node.type !== 'list') {
      const val = this.resolveAtom(node);
      if (val.startsWith('r')) {
        this.emit(`  ${jumpOnFalse ? 'JEQ' : 'JNE'} ${val} 0 ${label}`);
      } else {
        const n = parseInt(val);
        if (jumpOnFalse && n === 0) this.emit(`  JMP ${label}`);
        if (!jumpOnFalse && n !== 0) this.emit(`  JMP ${label}`);
      }
      return;
    }

    const list = node.value;
    if (!list.length) return;
    const op = list[0].value;

    const jmpOps = {
      '=':  { t: 'JEQ', f: 'JNE' },
      '!=': { t: 'JNE', f: 'JEQ' },
      '>':  { t: 'JGT', f: null },
      '<':  { t: 'JLT', f: null },
      '>=': { t: null,  f: 'JLT' },
      '<=': { t: null,  f: 'JGT' },
    };

    if (jmpOps[op]) {
      const { reg: a, allocated } = this.ensureInReg(list[1]);
      const b = this.resolveAtom(list[2]);
      const info = jmpOps[op];

      if (jumpOnFalse) {
        if (info.f) {
          this.emit(`  ${info.f} ${a} ${b} ${label}`);
        } else {
          const skip = this.freshLabel('skip');
          this.emit(`  ${info.t} ${a} ${b} ${skip}`);
          this.emit(`  JMP ${label}`);
          this.emitLabel(skip);
        }
      } else {
        if (info.t) {
          this.emit(`  ${info.t} ${a} ${b} ${label}`);
        } else {
          const skip = this.freshLabel('skip');
          this.emit(`  ${info.f} ${a} ${b} ${skip}`);
          this.emit(`  JMP ${label}`);
          this.emitLabel(skip);
        }
      }
      if (allocated) this.freeReg(a);
      return;
    }

    if (op === 'not') { this.compileCondJump(list[1], label, !jumpOnFalse); return; }
    if (op === 'zero?') {
      const { reg: a, allocated } = this.ensureInReg(list[1]);
      this.emit(`  ${jumpOnFalse ? 'JNE' : 'JEQ'} ${a} 0 ${label}`);
      if (allocated) this.freeReg(a);
      return;
    }
    if (op === 'carrying?') {
      const reg = this.allocReg();
      this.emit(`  CARRYING ${reg}`);
      this.emit(`  ${jumpOnFalse ? 'JEQ' : 'JNE'} ${reg} 0 ${label}`);
      this.freeReg(reg);
      return;
    }

    // General: compile to reg, test
    const reg = this.allocReg();
    this.compileExpr(node, reg);
    this.emit(`  ${jumpOnFalse ? 'JEQ' : 'JNE'} ${reg} 0 ${label}`);
    this.freeReg(reg);
  }

  compileComparison(list, destReg) {
    const reg = destReg || this.allocReg();
    const trueLabel = this.freshLabel('cmp_true');
    const endLabel = this.freshLabel('cmp_end');
    this.compileCondJump({ type: 'list', value: list }, trueLabel, false);
    this.emit(`  SET ${reg} 0`);
    this.emit(`  JMP ${endLabel}`);
    this.emitLabel(trueLabel);
    this.emit(`  SET ${reg} 1`);
    this.emitLabel(endLabel);
    return reg;
  }

  // ── dispatch ──

  compileDispatch(list) {
    const idReg = this.allocReg();
    this.compileInto(list[1], idReg);
    const endLabel = this.freshLabel('end_dispatch');
    for (let i = 2; i < list.length; i++) {
      const clause = list[i].value;
      const roleName = clause[0].value;
      const role = this.roles.find(r => r.name === roleName);
      if (!role) throw this.errorAt(`Unknown role: ${roleName}`);
      const nextLabel = this.freshLabel('next_role');
      this.emit(`  JNE ${idReg} ${role.id} ${nextLabel}`);
      this.emit(`  TAG ${role.id}`);
      for (let j = 1; j < clause.length; j++) this.compileExpr(clause[j]);
      this.emit(`  JMP ${endLabel}`);
      this.emitLabel(nextLabel);
    }
    this.emitLabel(endLabel);
    this.freeReg(idReg);
    return null;
  }
}

// ─── COMPILE ERROR ───────────────────────────────────────────

class CompileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CompileError';
  }
}

// ─── PUBLIC API ──────────────────────────────────────────────

function compileAntLisp(source) {
  const tokens = tokenize(source);
  const ast = parse(tokens);
  const compiler = new Compiler();
  return compiler.compile(ast);
}

// ─── CLI ─────────────────────────────────────────────────────

if (require.main === module) {
  const fs = require('fs');
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('Usage: node antlisp.js <source.lisp>');
  } else {
    try {
      const source = fs.readFileSync(args[0], 'utf-8');
      console.log(compileAntLisp(source));
    } catch (err) {
      if (err instanceof CompileError) {
        console.error(`error: ${err.message}`);
        process.exit(1);
      }
      throw err;  // Re-throw unexpected errors with stack trace
    }
  }
}

module.exports = { compileAntLisp, tokenize, parse, Compiler, CompileError };
