// ═══════════════════════════════════════════════════════════════
// AntLisp v2 — S-Expression Compiler for Antssembly
// ═══════════════════════════════════════════════════════════════

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

    this.allBindings = new Map();  // every let-binding ever made: name -> reg (for debug/assert-reg-name)

    this.macros = new Map();       // macro name -> { params: [...], body: [...] }
    this.constValues = new Map();  // const name -> resolved value (for inline substitution)
    this.roles = [];
    this.aliases = [];
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
      if (this.constValues.has(name)) return this.constValues.get(name);  // inline constants
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
    // Pass 1: collect roles
    for (const node of ast.body) {
      if (node.type === 'list' && node.value.length > 0) {
        const head = node.value[0];
        if (head.type === 'symbol') {
          if (head.value === 'define-role') this.collectRole(node.value);
        }
      }
    }

    // Emit directives (constants are resolved inline, not emitted)
    for (const r of this.roles) this.emit(`.tag ${r.id} ${r.name}`);
    for (const a of this.aliases) this.emit(`.alias ${a.name} ${a.reg}`);
    if (this.roles.length || this.aliases.length) this.emit('');

    // Pass 2: compile
    for (const node of ast.body) {
      this.compileTopLevel(node);
    }

    this.peephole();

    return this.output.join('\n');
  }

  // ── Peephole optimizer ──
  // Runs on the flat output array after compilation.

  peephole() {
    // Pass 1: Dead store elimination.
    // Remove SET rX <val> when the very next non-blank, non-comment line
    // is also SET rX <val2> (same register) with no label in between.
    // A label between them means the first SET might be a jump target.
    // Run in a loop until no more eliminations are found (handles chains
    // like SET r0 0; SET r0 1; SET r0 2; SET r0 3 → SET r0 3).
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < this.output.length - 1; i++) {
        const line = this.output[i].trim();
        // Match: SET rN <anything>
        const m1 = line.match(/^SET (r\d) .+/);
        if (!m1) continue;
        const reg = m1[1];
        // Look ahead for the next non-blank, non-comment line
        let found = false;
        for (let j = i + 1; j < this.output.length; j++) {
          const next = this.output[j].trim();
          if (next === '') continue;                    // skip blank
          if (next.startsWith(';')) continue;            // skip comment
          if (next.endsWith(':')) break;                 // label — stop, not safe
          // Is it a SET to the same register?
          const m2 = next.match(/^SET (r\d) .+/);
          if (m2 && m2[1] === reg) {
            // Dead store — remove the first SET
            this.output.splice(i, 1);
            i--;
            changed = true;
            found = true;
          }
          break;  // whether matched or not, stop looking
        }
      }
    }

    // Pass 2: Remove redundant JMP instructions that jump to a label which
    // would be reached by fall-through (only labels/blanks between).
    for (let i = 0; i < this.output.length; i++) {
      const line = this.output[i].trim();
      if (!line.startsWith('JMP ')) continue;
      const target = line.split(/\s+/)[1];
      // Look ahead: skip labels and blank lines
      let redundant = false;
      for (let j = i + 1; j < this.output.length; j++) {
        const next = this.output[j].trim();
        if (next === '') continue;                    // blank line
        if (next.endsWith(':')) {
          // It's a label — check if it's our target
          const label = next.slice(0, -1);
          if (label === target) { redundant = true; break; }
          continue;                                   // some other label, keep scanning
        }
        break;                                        // hit a real instruction, stop
      }
      if (redundant) {
        this.output.splice(i, 1);
        i--;  // re-check this index since we removed an element
      }
    }
  }

  // ── (defmacro name (params...) body...) ──
  collectMacro(list) {
    const name = list[1].value;
    const params = list[2].value.map(p => p.value);  // list of param names
    const body = list.slice(3);  // remaining forms are the body
    // Capture definition-site bindings for hygienic expansion.
    // When the macro body is compiled, free variables resolve against
    // these bindings rather than the call-site bindings.
    const closedBindings = new Map(this.bindings);
    const closedConsts = new Map(this.constValues);
    this.macros.set(name, { params, body, closedBindings, closedConsts });
  }

  // Compile a hygienic macro call.
  // 1. Evaluate arguments in the call-site scope
  // 2. Switch to definition-site bindings + param→register overlays
  // 3. Compile the body (with freshened labels)
  // 4. Restore call-site bindings and free param registers
  compileMacroCall(name, args, callNode, destReg) {
    const macro = this.macros.get(name);
    if (macro.params.length !== args.length) {
      throw this.errorAt(`Macro ${name} expects ${macro.params.length} args, got ${args.length}`, callNode);
    }

    // Step 1: Evaluate each argument in the CALL-SITE scope.
    // For register args: alias the param to the same register (allows set!)
    // For literal args: store as a const (no register needed, but not mutable)
    // For compound expressions: compile into a temp register
    const paramBindings = [];  // { paramName, reg?, constVal?, allocated }
    for (let i = 0; i < macro.params.length; i++) {
      const arg = args[i];
      const paramName = macro.params[i];

      if (arg.type === 'number') {
        // Literal number — store as const for zero-cost inlining
        paramBindings.push({ paramName, constVal: String(arg.value), allocated: false });
      } else if (arg.type === 'symbol') {
        const resolved = this.resolveAtom(arg);
        if (resolved.startsWith('r')) {
          // Variable — bind param directly to the same register (alias).
          // This allows (set! param ...) to mutate the caller's variable.
          paramBindings.push({ paramName, reg: resolved, allocated: false });
        } else {
          // Literal/constant/direction/channel — store as const
          paramBindings.push({ paramName, constVal: resolved, allocated: false });
        }
      } else {
        // Compound expression — compile into a temp register
        const reg = this.allocReg();
        this.compileExpr(arg, reg);
        paramBindings.push({ paramName, reg, allocated: true });
      }
    }

    // Step 2: Switch to definition-site bindings, overlay params
    const savedBindings = this.bindings;
    const savedConsts = this.constValues;

    this.bindings = new Map(macro.closedBindings);
    this.constValues = new Map(macro.closedConsts);

    // Overlay parameter bindings (these take priority over closed-over names).
    // Remove the param name from all maps first to avoid stale shadowing,
    // then add it to the correct map.
    for (const pb of paramBindings) {
      this.bindings.delete(pb.paramName);
      this.constValues.delete(pb.paramName);
      if (pb.reg) {
        this.bindings.set(pb.paramName, pb.reg);
      } else if (pb.constVal !== undefined) {
        this.constValues.set(pb.paramName, pb.constVal);
      }
    }

    // Step 3: Freshen labels in the body and compile
    const prefix = `__${name}_${this.labelCounter++}`;
    const expandedBody = macro.body.map(node => this.freshenLabels(node, prefix));

    let result = null;
    for (let i = 0; i < expandedBody.length; i++) {
      result = this.compileExpr(expandedBody[i], i === expandedBody.length - 1 ? destReg : null);
    }

    // Step 4: Restore call-site bindings, free allocated param registers
    this.bindings = savedBindings;
    this.constValues = savedConsts;

    for (const pb of paramBindings) {
      if (pb.allocated) this.freeReg(pb.reg);
    }

    return result;
  }

  // Recursively freshen (label ...) and (goto ...) names in an AST node
  freshenLabels(node, labelPrefix) {
    if (node.type !== 'list') return node;
    const list = node.value;
    if (list.length === 0) return node;

    const head = list[0];

    // Handle (label foo) — freshen the label name
    if (head.type === 'symbol' && head.value === 'label' && list.length >= 2) {
      const labelName = list[1].value;
      const freshLabel = `${labelPrefix}_${labelName}`;
      return {
        type: 'list',
        value: [head, { type: 'symbol', value: freshLabel, line: list[1].line, col: list[1].col }],
        line: node.line,
        col: node.col
      };
    }

    // Handle (goto foo) — freshen the label name
    if (head.type === 'symbol' && head.value === 'goto' && list.length >= 2) {
      const labelName = list[1].value;
      const freshLabel = `${labelPrefix}_${labelName}`;
      return {
        type: 'list',
        value: [head, { type: 'symbol', value: freshLabel, line: list[1].line, col: list[1].col }],
        line: node.line,
        col: node.col
      };
    }

    // Recurse into list elements
    return {
      type: 'list',
      value: list.map(child => this.freshenLabels(child, labelPrefix)),
      line: node.line,
      col: node.col
    };
  }


  collectRole(list) {
    this.roles.push({ name: list[1].value, id: list[2].value });
  }

  compileTopLevel(node) {
    if (node.type !== 'list' || node.value.length === 0) return;
    const head = node.value[0];
    if (head.type !== 'symbol') { 
      this.compileExpr(node); 
      return; 
    }

    switch (head.value) {
      case 'define-role': return; // already collected
      case 'defmacro':    return this.collectMacro(node.value);
      case 'define':      throw this.errorAt('(define ...) is not supported — use (let ((var expr)) ...) instead', node);
      case 'alias':       return this.compileAlias(node.value);
      case 'const':       return this.compileConst(node.value);

      default:
        this.compileExpr(node);
    }
  }

  // ── (alias name reg) ──
  compileAlias(list) {
    this.aliases.push({ name: list[1].value, reg: list[2].value });
  }

  // ── (const name value) ──
  // Constants are resolved inline (no .const directive emitted)
  compileConst(list) {
    const name = list[1].value;
    const value = this.resolveAtom(list[2]);
    this.constValues.set(name, value);  // store for inline substitution
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
      case 'defmacro': this.collectMacro(list); return null;

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
        // Check if it's a macro call
        if (this.macros.has(op)) {
          return this.compileMacroCall(op, list.slice(1), node, destReg);
        }
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
      this.allBindings.set(name, reg);  // record for assert-reg-name
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
    const reg = this.bindings.get(name);
    if (!reg) throw this.errorAt(`Undefined variable: ${name}`);
    this.compileInto(list[2], reg);
    return reg;
  }

  // ── if / when / unless / cond / begin ──

  // Check if a condition node would require a trampoline (2-instruction
  // jump sequence) when compiled with the given jumpOnFalse polarity.
  needsTrampoline(node, jumpOnFalse) {
    if (node.type !== 'list') return false;
    const list = node.value;
    if (!list.length) return false;
    const op = list[0].value;

    const jmpOps = {
      '=':  { t: 'JEQ', f: 'JNE' },
      '!=': { t: 'JNE', f: 'JEQ' },
      '>':  { t: 'JGT', f: null },
      '<':  { t: 'JLT', f: null },
      '>=': { t: null,  f: 'JLT' },
      '<=': { t: null,  f: 'JGT' },
    };

    const info = jmpOps[op];
    if (!info) {
      // (not cond) flips polarity
      if (op === 'not') return this.needsTrampoline(list[1], !jumpOnFalse);
      return false;
    }
    return jumpOnFalse ? !info.f : !info.t;
  }

  compileIf(list, destReg) {
    const hasElse = list.length > 3;

    // Optimization: if jumping-on-false would need a trampoline but
    // jumping-on-true would not, swap then/else bodies and use the
    // direct single-instruction jump instead.
    if (hasElse &&
        this.needsTrampoline(list[1], true) &&
        !this.needsTrampoline(list[1], false)) {
      const thenLabel = this.freshLabel('then');
      const endLabel = this.freshLabel('endif');
      // Jump directly to then-body when condition is true
      this.compileCondJump(list[1], thenLabel, false);
      // Else-body first (fall-through when condition is false)
      this.compileExpr(list[3], destReg);
      this.emit(`  JMP ${endLabel}`);
      this.emitLabel(thenLabel);
      // Then-body
      this.compileExpr(list[2], destReg);
      this.emitLabel(endLabel);
      return destReg;
    }

    const elseLabel = this.freshLabel('else');
    const endLabel = this.freshLabel('endif');
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
        // Operand is same register as dest — negate in-place
        this.emit(`  MUL ${reg} -1`);
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

// Like compileAntLisp but returns { asm, varMap } where varMap is a
// Map<varName, regString> of all let-bindings ever created in the program.
// Used by the unit test harness for assert-reg-name lookups.
function compileAntLispDebug(source) {
  const tokens = tokenize(source);
  const ast = parse(tokens);
  const compiler = new Compiler();
  const asm = compiler.compile(ast);
  // compiler.allBindings is Map<name, regString> built during compileLet
  return { asm, varMap: new Map(compiler.allBindings) };
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

module.exports = { compileAntLisp, compileAntLispDebug, tokenize, parse, Compiler, CompileError };
