// ═══════════════════════════════════════════════════════════════
// AntLisp Pipeline — Phase 3: SSA IR Types + Lowering
// ═══════════════════════════════════════════════════════════════

import { ASTNode, ListNode } from './parse';
import { TagDef } from './metadata';
import { tryEvalConst } from './expand';

// ─── SSA IR Types ───────────────────────────────────────────

export interface PhiNode {
  dest: string;                                // e.g. "%t5"
  entries: { block: BasicBlock; value: string }[];
}

export interface SSAInstr {
  op: string;                                  // instruction opcode
  dest: string | null;                         // null for void ops
  args: (string | number)[];                   // temps, constants, literals
}

export type TerminatorOp = 'jmp' | 'br_cmp';
export type CmpOp = 'eq' | 'ne' | 'lt' | 'gt' | 'le' | 'ge';

export interface JmpTerminator {
  op: 'jmp';
  target: BasicBlock;
}

export interface BrCmpTerminator {
  op: 'br_cmp';
  cmpOp: CmpOp;
  a: string | number;
  b: string | number;
  thenBlock: BasicBlock;
  elseBlock: BasicBlock;
}

export type Terminator = JmpTerminator | BrCmpTerminator;

export interface BasicBlock {
  label: string;
  phis: PhiNode[];
  instrs: SSAInstr[];
  terminator: Terminator | null;
  preds: BasicBlock[];
  succs: BasicBlock[];
}

export interface SSAProgram {
  blocks: BasicBlock[];
  entryBlock: BasicBlock;
  nextTemp: number;
  tags: TagDef[];
  allBindings: Map<string, string>;  // var name → last SSA temp (for debug)
  tempNames: Map<string, string>;    // temp → var name (for debug)
  tempLocs: Map<string, { file: string; line: number; col: number }>;  // temp → source location
}

// ─── Side-effect classification ─────────────────────────────

const SIDE_EFFECT_FREE_OPS = new Set([
  'const', 'copy',
  'add', 'sub', 'mul', 'div', 'mod',
  'and', 'or', 'xor', 'lshift', 'rshift',
  'random',
  'sense', 'smell', 'probe', 'sniff',
  'carrying', 'id',
]);

export function isSideEffectFree(op: string): boolean {
  return SIDE_EFFECT_FREE_OPS.has(op);
}

// ─── SSA Program Builder ────────────────────────────────────

function freshBlock(label: string): BasicBlock {
  return {
    label,
    phis: [],
    instrs: [],
    terminator: null,
    preds: [],
    succs: [],
  };
}

function addEdge(from: BasicBlock, to: BasicBlock): void {
  from.succs.push(to);
  to.preds.push(from);
}

// Direction / channel / target resolution for assembly operands
function resolveAssemblyAtom(name: string, consts: Map<string, string>, tags: TagDef[]): string {
  if (consts.has(name)) return consts.get(name)!;
  const lower = name.toLowerCase();
  if (['n', 'e', 's', 'w', 'north', 'east', 'south', 'west', 'random', 'here'].includes(lower)) return name.toUpperCase();
  if (['ch_red', 'ch_blue', 'ch_green', 'ch_yellow'].includes(lower)) return name.toUpperCase();
  if (['food', 'wall', 'nest', 'ant', 'empty'].includes(lower)) return name.toUpperCase();
  if (name === '#t' || name === 'true') return '1';
  if (name === '#f' || name === 'false') return '0';
  const tag = tags.find(t => t.name === name);
  if (tag) return String(tag.id);
  return name.toUpperCase();
}

// ─── Lowering ───────────────────────────────────────────────

type Env = Map<string, string>;  // variable name → SSA temp

export class SSALowering {
  private nextTemp = 0;
  private nextBlock = 0;
  private blocks: BasicBlock[] = [];
  private currentBlock: BasicBlock;
  private env: Env;
  private loopStack: {
    headerBlock: BasicBlock;
    exitBlock: BasicBlock;
    // For unrolled loops: phi maps for the continue target and break target
    headerPhiMap?: Map<string, string>;
    exitPhiMap?: Map<string, string>;
  }[] = [];
  private tagbodyStack: {
    tags: Map<string, BasicBlock>;
    phiMaps: Map<string, Map<string, string>>;  // tag name → (var name → phi temp)
  }[] = [];
  private tags: TagDef[];
  private consts: Map<string, string>;
  private sourceFile: string;
  allBindings = new Map<string, string>();  // for debug: var name → last temp
  tempNames = new Map<string, string>();    // for debug: temp → var name
  tempLocs = new Map<string, { file: string; line: number; col: number }>();  // temp → source location

  constructor(tags: TagDef[], consts: Map<string, string>, sourceFile = '') {
    this.tags = tags;
    this.consts = consts;
    this.sourceFile = sourceFile;
    this.env = new Map();
    this.currentBlock = this.makeBlock('entry');
  }

  private freshTemp(node?: ASTNode): string {
    const temp = `%t${this.nextTemp++}`;
    if (node && this.sourceFile) {
      this.tempLocs.set(temp, { file: this.sourceFile, line: node.line, col: node.col });
    }
    return temp;
  }

  private makeBlock(hint: string): BasicBlock {
    const block = freshBlock(`__${hint}_${this.nextBlock++}`);
    this.blocks.push(block);
    return block;
  }

  private emit(op: string, dest: string | null, ...args: (string | number)[]): void {
    this.currentBlock.instrs.push({ op, dest, args });
  }

  private setTerminator(term: Terminator): void {
    if (this.currentBlock.terminator) return;  // already terminated (e.g. break/continue/go)
    this.currentBlock.terminator = term;
  }

  private sealBlock(block: BasicBlock): void {
    this.currentBlock = block;
  }

  private jumpTo(target: BasicBlock): void {
    this.setTerminator({ op: 'jmp', target });
    addEdge(this.currentBlock, target);
  }

  private branchTo(cmpOp: CmpOp, a: string | number, b: string | number,
                   thenBlock: BasicBlock, elseBlock: BasicBlock): void {
    this.setTerminator({ op: 'br_cmp', cmpOp, a, b, thenBlock, elseBlock });
    addEdge(this.currentBlock, thenBlock);
    addEdge(this.currentBlock, elseBlock);
  }

  // Resolve an atom (symbol or number) to an SSA operand
  private resolveAtom(node: ASTNode): string | number {
    if (node.type === 'number') return node.value;
    if (node.type === 'symbol') {
      const name = node.value;
      if (this.env.has(name)) return this.env.get(name)!;
      // Try to resolve as a known constant/direction/channel
      return resolveAssemblyAtom(name, this.consts, this.tags);
    }
    throw new Error(`Cannot resolve atom: ${JSON.stringify(node)}`);
  }

  // Resolve operand, compiling compound expressions into temps
  private resolveOperand(node: ASTNode): string | number {
    if (node.type === 'number') return node.value;
    if (node.type === 'symbol') return this.resolveAtom(node);
    // Compound expression — compile it
    return this.lowerExpr(node);
  }

  // ── Main lowering entry ──

  lower(forms: ASTNode[]): SSAProgram {
    for (const form of forms) {
      this.lowerExpr(form);
    }

    return {
      blocks: this.blocks,
      entryBlock: this.blocks[0],
      nextTemp: this.nextTemp,
      tags: this.tags,
      allBindings: this.allBindings,
      tempNames: this.tempNames,
      tempLocs: this.tempLocs,
    };
  }

  // Lower an expression, returning the SSA temp holding its value (or '' for void)
  private lowerExpr(node: ASTNode): string {
    if (node.type === 'number') {
      const temp = this.freshTemp(node);
      this.emit('const', temp, node.value);
      return temp;
    }

    if (node.type === 'symbol') {
      const val = this.resolveAtom(node);
      if (typeof val === 'string' && val.startsWith('%t')) {
        return val;  // already an SSA temp
      }
      // It's a constant/direction — emit const
      const temp = this.freshTemp(node);
      if (typeof val === 'number') {
        this.emit('const', temp, val);
      } else {
        const n = parseInt(val, 10);
        if (!isNaN(n)) {
          this.emit('const', temp, n);
        } else {
          // It's a string literal like "RANDOM" — keep as-is
          this.emit('const', temp, val);
        }
      }
      return temp;
    }

    if (node.type !== 'list' || node.value.length === 0) return '';

    const list = node.value;
    const head = list[0];
    if (head.type !== 'symbol') {
      throw new Error(`Expected symbol at head of expression, got ${head.type} at line ${node.line}:${node.col}`);
    }
    const op = head.value;

    switch (op) {
      case 'begin': return this.lowerBegin(list);
      case 'let': return this.lowerLet(list);
      case 'let*': return this.lowerLetStar(list);
      case 'set!': return this.lowerSet(list, node);
      case 'if': return this.lowerIf(list, node);
      case 'when': return this.lowerWhen(list, node);
      case 'unless': return this.lowerUnless(list, node);
      case 'cond': return this.lowerCond(list, node);
      case 'loop': return this.lowerLoop(list);
      case 'while': return this.lowerWhile(list, node);
      case 'dotimes': return this.lowerDotimes(list, node);
      case 'dolist': return this.lowerDolist(list, node);
      case 'break': return this.lowerBreak();
      case 'continue': return this.lowerContinue();
      case 'tagbody': return this.lowerTagbody(list);
      case 'go': return this.lowerGo(list);

      // Arithmetic
      case '+': case '-': case '*': case '/':
      case 'mod': case 'and': case 'or': case 'xor':
      case 'lshift': case 'rshift':
        return this.lowerArith(op, list, node);
      case 'random':
        return this.lowerRandom(list, node);

      // Sensing
      case 'sense': return this.lowerSenseOp('sense', list, node);
      case 'smell': return this.lowerSenseOp('smell', list, node);
      case 'probe': return this.lowerSenseOp('probe', list, node);
      case 'sniff': return this.lowerSniff(list, node);
      case 'carrying?': return this.lowerNullaryOp('carrying', node);
      case 'id': return this.lowerNullaryOp('id', node);

      // Actions
      case 'move': return this.lowerMove(list);
      case 'pickup': { this.emit('pickup', null); return ''; }
      case 'drop': { this.emit('drop', null); return ''; }
      case 'mark': return this.lowerMark(list);
      case 'set-tag': return this.lowerSetTag(list);

      // Comparisons (produce a value)
      case '=': case '!=': case '>': case '<': case '>=': case '<=':
        return this.lowerComparison(op, list, node);
      case 'not':
        return this.lowerNot(list, node);
      case 'zero?':
        return this.lowerZeroQ(list, node);

      case 'abort!': return this.lowerAbort(list, node);
      case 'reg':    return this.lowerReg(list, node);
      case 'defmacro': return '';  // should have been removed by expand phase

      default:
        throw new Error(`Unknown form: ${op} at line ${node.line}:${node.col}`);
    }
  }

  // ── begin ──
  private lowerBegin(list: ASTNode[]): string {
    let result = '';
    for (let i = 1; i < list.length; i++) {
      result = this.lowerExpr(list[i]);
    }
    return result;
  }

  // ── let (parallel bindings: all inits evaluated before any name is bound) ──
  private lowerLet(list: ASTNode[]): string {
    const bindings = (list[1] as ListNode).value;
    const savedEnv = new Map(this.env);

    // Evaluate all init expressions in the outer environment first
    const evaluated: { name: string; temp: string }[] = [];
    for (const binding of bindings) {
      const pair = (binding as ListNode).value;
      const name = (pair[0] as any).value as string;
      const initTemp = this.lowerExpr(pair[1]);
      evaluated.push({ name, temp: initTemp });
    }

    // Then bind all names at once
    for (const { name, temp } of evaluated) {
      this.env.set(name, temp);
      this.allBindings.set(name, temp);
      this.tempNames.set(temp, name);
    }

    let result = '';
    for (let i = 2; i < list.length; i++) {
      result = this.lowerExpr(list[i]);
    }

    // Restore let-local bindings but preserve set! updates to outer variables.
    // Any variable that existed before the let and was mutated (set!) inside
    // the let body must keep its updated SSA temp in the restored env.
    for (const [name, temp] of this.env) {
      if (savedEnv.has(name)) {
        savedEnv.set(name, temp);
      }
    }
    this.env = savedEnv;
    return result;
  }

  // ── let* (sequential bindings: each init can see previous bindings) ──
  private lowerLetStar(list: ASTNode[]): string {
    const bindings = (list[1] as ListNode).value;
    const savedEnv = new Map(this.env);

    for (const binding of bindings) {
      const pair = (binding as ListNode).value;
      const name = (pair[0] as any).value as string;
      const initTemp = this.lowerExpr(pair[1]);
      this.env.set(name, initTemp);
      this.allBindings.set(name, initTemp);
      this.tempNames.set(initTemp, name);
    }

    let result = '';
    for (let i = 2; i < list.length; i++) {
      result = this.lowerExpr(list[i]);
    }

    // Restore let-local bindings but preserve set! updates to outer variables.
    for (const [name, temp] of this.env) {
      if (savedEnv.has(name)) {
        savedEnv.set(name, temp);
      }
    }
    this.env = savedEnv;
    return result;
  }

  // ── set! ──
  private lowerSet(list: ASTNode[], node: ASTNode): string {
    const name = (list[1] as any).value as string;
    const valTemp = this.lowerExpr(list[2]);
    // Create a fresh temp for the new value (SSA property)
    const newTemp = this.freshTemp(node);
    this.emit('copy', newTemp, valTemp);
    this.env.set(name, newTemp);
    this.allBindings.set(name, newTemp);
    this.tempNames.set(newTemp, name);
    return newTemp;
  }

  // ── if ──
  private lowerIf(list: ASTNode[], node: ASTNode): string {
    const cond = list[1];
    const thenBody = list[2];
    const elseBody = list.length > 3 ? list[3] : null;

    const thenBlock = this.makeBlock('then');
    const elseBlock = elseBody ? this.makeBlock('else') : this.makeBlock('endif');
    const mergeBlock = elseBody ? this.makeBlock('endif') : elseBlock;

    // Compile condition
    this.lowerCondBranch(cond, thenBlock, elseBody ? elseBlock : mergeBlock);

    // Then branch
    const envBeforeThen = new Map(this.env);
    this.sealBlock(thenBlock);
    const thenResult = this.lowerExpr(thenBody);
    const thenEnv = new Map(this.env);
    const thenExitBlock = this.currentBlock;
    if (!thenExitBlock.terminator) {
      this.jumpTo(mergeBlock);
    }

    // Else branch
    let elseResult = '';
    let elseEnv: Map<string, string>;
    let elseExitBlock: BasicBlock;
    if (elseBody) {
      this.env = new Map(envBeforeThen);
      this.sealBlock(elseBlock);
      elseResult = this.lowerExpr(elseBody);
      elseEnv = new Map(this.env);
      elseExitBlock = this.currentBlock;
      if (!elseExitBlock.terminator) {
        this.jumpTo(mergeBlock);
      }
    } else {
      elseEnv = envBeforeThen;
      elseExitBlock = this.currentBlock;  // not used
    }

    // Merge block — insert phis for variables that diverged
    this.sealBlock(mergeBlock);
    if (elseBody) {
      this.insertPhis(thenEnv, elseEnv, thenExitBlock, elseExitBlock, envBeforeThen);
    } else {
      this.insertPhis(thenEnv, envBeforeThen, thenExitBlock, elseExitBlock, envBeforeThen);
    }

    // If both branches exist and produce different result temps, insert a phi
    // to select the if-expression's value.  Without this, only thenResult is
    // returned, which is undefined on the else path.
    if (elseBody && thenResult !== elseResult) {
      const resultPhi = this.freshTemp(node);
      this.currentBlock.phis.push({
        dest: resultPhi,
        entries: [
          { block: thenExitBlock, value: thenResult },
          { block: elseExitBlock, value: elseResult },
        ],
      });
      return resultPhi;
    }
    return thenResult;
  }

  // ── when / unless ──
  private lowerWhen(list: ASTNode[], node: ASTNode): string {
    const bodyBlock = this.makeBlock('when_body');
    const endBlock = this.makeBlock('endwhen');

    this.lowerCondBranch(list[1], bodyBlock, endBlock);

    const envBefore = new Map(this.env);
    const predBlock = this.currentBlock;
    this.sealBlock(bodyBlock);
    for (let i = 2; i < list.length; i++) {
      this.lowerExpr(list[i]);
    }
    const bodyEnv = new Map(this.env);
    const bodyExitBlock = this.currentBlock;
    if (!bodyExitBlock.terminator) {
      this.jumpTo(endBlock);
    }

    this.sealBlock(endBlock);
    this.insertPhis(bodyEnv, envBefore, bodyExitBlock, predBlock, envBefore);
    return '';
  }

  private lowerUnless(list: ASTNode[], node: ASTNode): string {
    const bodyBlock = this.makeBlock('unless_body');
    const endBlock = this.makeBlock('endunless');

    // unless: jump to body when condition is FALSE
    this.lowerCondBranch(list[1], endBlock, bodyBlock);

    const envBefore = new Map(this.env);
    const predBlock = this.currentBlock;
    this.sealBlock(bodyBlock);
    for (let i = 2; i < list.length; i++) {
      this.lowerExpr(list[i]);
    }
    const bodyEnv = new Map(this.env);
    const bodyExitBlock = this.currentBlock;
    if (!bodyExitBlock.terminator) {
      this.jumpTo(endBlock);
    }

    this.sealBlock(endBlock);
    this.insertPhis(bodyEnv, envBefore, bodyExitBlock, predBlock, envBefore);
    return '';
  }

  // ── cond ──
  private lowerCond(list: ASTNode[], node: ASTNode): string {
    const endBlock = this.makeBlock('endcond');
    const envBefore = new Map(this.env);
    const branchEnvs: { env: Map<string, string>; exitBlock: BasicBlock }[] = [];

    for (let i = 1; i < list.length; i++) {
      const clause = (list[i] as ListNode).value;
      const test = clause[0];

      if (test.type === 'symbol' && test.value === 'else') {
        // Else clause — just compile the body
        for (let j = 1; j < clause.length; j++) {
          this.lowerExpr(clause[j]);
        }
        branchEnvs.push({ env: new Map(this.env), exitBlock: this.currentBlock });
        if (!this.currentBlock.terminator) {
          this.jumpTo(endBlock);
        }
        break;
      }

      const bodyBlock = this.makeBlock('cond_body');
      const nextBlock = this.makeBlock('cond_next');

      this.lowerCondBranch(test, bodyBlock, nextBlock);

      this.sealBlock(bodyBlock);
      this.env = new Map(envBefore);
      for (let j = 1; j < clause.length; j++) {
        this.lowerExpr(clause[j]);
      }
      branchEnvs.push({ env: new Map(this.env), exitBlock: this.currentBlock });
      if (!this.currentBlock.terminator) {
        this.jumpTo(endBlock);
      }

      this.env = new Map(envBefore);
      this.sealBlock(nextBlock);
    }

    // If we fell through without else, jump to end
    if (!this.currentBlock.terminator) {
      branchEnvs.push({ env: new Map(this.env), exitBlock: this.currentBlock });
      this.jumpTo(endBlock);
    }

    this.sealBlock(endBlock);
    // Insert phis for all branches
    if (branchEnvs.length > 0) {
      this.insertPhisMulti(branchEnvs, envBefore);
    }
    return '';
  }

  // ── loop ──
  private lowerLoop(list: ASTNode[]): string {
    const headerBlock = this.makeBlock('loop');
    const bodyBlock = this.makeBlock('loop_body');
    const exitBlock = this.makeBlock('endloop');

    this.jumpTo(headerBlock);
    const loopPred = this.currentBlock;
    this.sealBlock(headerBlock);

    // Placeholder phis for mutable variables
    const envBefore = new Map(this.env);
    const phiMap = this.insertLoopHeaderPhis(headerBlock, envBefore, loopPred);

    this.jumpTo(bodyBlock);
    this.sealBlock(bodyBlock);

    this.loopStack.push({ headerBlock, exitBlock });

    for (let i = 1; i < list.length; i++) {
      this.lowerExpr(list[i]);
    }

    // Back edge
    if (!this.currentBlock.terminator) {
      this.fillLoopPhis(phiMap, this.env, this.currentBlock);
      this.jumpTo(headerBlock);
    }

    this.loopStack.pop();
    this.sealBlock(exitBlock);
    return '';
  }

  // ── while ──
  private lowerWhile(list: ASTNode[], node: ASTNode): string {
    const headerBlock = this.makeBlock('while');
    const bodyBlock = this.makeBlock('while_body');
    const exitBlock = this.makeBlock('endwhile');

    this.jumpTo(headerBlock);
    const whilePred = this.currentBlock;
    this.sealBlock(headerBlock);

    const envBefore = new Map(this.env);
    const phiMap = this.insertLoopHeaderPhis(headerBlock, envBefore, whilePred);

    // Condition
    this.lowerCondBranch(list[1], bodyBlock, exitBlock);

    this.sealBlock(bodyBlock);
    this.loopStack.push({ headerBlock, exitBlock });

    for (let i = 2; i < list.length; i++) {
      this.lowerExpr(list[i]);
    }

    // Back edge
    if (!this.currentBlock.terminator) {
      this.fillLoopPhis(phiMap, this.env, this.currentBlock);
      this.jumpTo(headerBlock);
    }

    this.loopStack.pop();
    this.sealBlock(exitBlock);
    // Restore loop header phis into env
    for (const [name, phiTemp] of phiMap) {
      this.env.set(name, phiTemp);
    }
    return '';
  }

  // ── dotimes ──
  private lowerDotimes(list: ASTNode[], node: ASTNode): string {
    const pair = (list[1] as ListNode).value;
    const varName = (pair[0] as any).value as string;

    // Try to unroll when count is a compile-time constant
    const constCount = tryEvalConst(pair[1], this.consts);
    if (constCount !== null) {
      return this.lowerDotimesUnrolled(varName, constCount, list, node);
    }

    const countVal = this.resolveOperand(pair[1]);

    // Initialize loop variable
    const initTemp = this.freshTemp(node);
    this.emit('const', initTemp, 0);

    const savedEnv = new Map(this.env);
    this.env.set(varName, initTemp);
    this.allBindings.set(varName, initTemp);
    this.tempNames.set(initTemp, varName);

    const headerBlock = this.makeBlock('dotimes');
    const bodyBlock = this.makeBlock('dotimes_body');
    const exitBlock = this.makeBlock('enddotimes');

    this.jumpTo(headerBlock);
    const dotimesPred = this.currentBlock;
    this.sealBlock(headerBlock);

    const envBefore = new Map(this.env);
    const phiMap = this.insertLoopHeaderPhis(headerBlock, envBefore, dotimesPred);

    // Condition: i == count → exit
    const iTemp = this.env.get(varName)!;
    this.branchTo('eq', iTemp, countVal, exitBlock, bodyBlock);

    this.sealBlock(bodyBlock);
    this.loopStack.push({ headerBlock, exitBlock });

    for (let i = 2; i < list.length; i++) {
      this.lowerExpr(list[i]);
    }

    // Increment
    const newI = this.freshTemp(node);
    this.emit('add', newI, this.env.get(varName)!, 1);
    this.env.set(varName, newI);

    // Back edge
    if (!this.currentBlock.terminator) {
      this.fillLoopPhis(phiMap, this.env, this.currentBlock);
      this.jumpTo(headerBlock);
    }

    this.loopStack.pop();
    this.sealBlock(exitBlock);
    // Restore env to remove the loop variable from scope, then
    // overlay loop header phis so post-loop code sees updated values
    this.env = savedEnv;
    for (const [name, phiTemp] of phiMap) {
      if (savedEnv.has(name)) {
        this.env.set(name, phiTemp);
      }
    }
    return '';
  }

  // Unrolled dotimes: each iteration gets its own block with phi nodes
  // for outer env vars so break/continue work correctly.
  private lowerDotimesUnrolled(varName: string, count: number, list: ASTNode[], node: ASTNode): string {
    const savedEnv = new Map(this.env);

    // Zero iterations — no-op
    if (count <= 0) {
      return '';
    }

    const exitBlock = this.makeBlock('enddotimes');

    // Create all iteration blocks up front
    const iterBlocks: BasicBlock[] = [];
    for (let i = 0; i < count; i++) {
      iterBlocks.push(this.makeBlock(`dotimes_${i}`));
    }

    // Jump into the first iteration
    this.jumpTo(iterBlocks[0]);
    const firstPred = this.currentBlock;

    // Insert phi nodes at each iteration block (and exit) for outer env vars
    const iterPhiMaps: Map<string, string>[] = [];
    for (let i = 0; i < count; i++) {
      const phiMap = new Map<string, string>();
      if (i === 0) {
        // First iteration only has one predecessor — no phis needed
      } else {
        for (const [name, _temp] of savedEnv) {
          const phiTemp = this.freshTemp();
          iterBlocks[i].phis.push({
            dest: phiTemp,
            entries: [],
          });
          phiMap.set(name, phiTemp);
        }
      }
      iterPhiMaps.push(phiMap);
    }

    // Insert phis at exitBlock for outer env vars
    const exitPhiMap = new Map<string, string>();
    for (const [name, _temp] of savedEnv) {
      const phiTemp = this.freshTemp();
      exitBlock.phis.push({
        dest: phiTemp,
        entries: [],
      });
      exitPhiMap.set(name, phiTemp);
    }

    for (let i = 0; i < count; i++) {
      this.sealBlock(iterBlocks[i]);

      // Update env to use phi temps for non-first iterations
      if (i > 0) {
        for (const [name, phiTemp] of iterPhiMaps[i]) {
          this.env.set(name, phiTemp);
        }
      }

      // Bind loop variable to this iteration's constant value
      const valTemp = this.freshTemp(node);
      this.emit('const', valTemp, i);
      this.env.set(varName, valTemp);
      this.allBindings.set(varName, valTemp);
      this.tempNames.set(valTemp, varName);

      // break → exitBlock, continue → next iter (or exit if last)
      const nextBlock = i + 1 < count ? iterBlocks[i + 1] : exitBlock;
      const headerPhiMap = i + 1 < count ? iterPhiMaps[i + 1] : exitPhiMap;
      this.loopStack.push({ headerBlock: nextBlock, exitBlock, headerPhiMap, exitPhiMap });

      // Lower body
      for (let j = 2; j < list.length; j++) {
        this.lowerExpr(list[j]);
      }

      // Fall through to next iteration or exit
      if (!this.currentBlock.terminator) {
        const targetPhiMap = i + 1 < count ? iterPhiMaps[i + 1] : exitPhiMap;
        this.fillUnrolledPhis(targetPhiMap, nextBlock, this.env, this.currentBlock);
        this.jumpTo(nextBlock);
      }

      this.loopStack.pop();
    }

    this.sealBlock(exitBlock);

    // Restore env: use exit phi temps for outer vars
    this.env = savedEnv;
    for (const [name, phiTemp] of exitPhiMap) {
      this.env.set(name, phiTemp);
    }
    return '';
  }

  // ── dolist ──
  // (dolist (var (values v1 v2 ...)) body...)
  // All values must be compile-time constants. Fully unrolled.
  // Each iteration block gets phi nodes for outer env vars so that
  // break/continue (which bypass normal merge points) work correctly.
  private lowerDolist(list: ASTNode[], node: ASTNode): string {
    const pair = (list[1] as ListNode).value;
    const varName = (pair[0] as any).value as string;
    const valuesForm = (pair[1] as ListNode).value;
    if (valuesForm[0].type !== 'symbol' || valuesForm[0].value !== 'values') {
      throw new Error(`dolist expects (values ...) as second element at line ${node.line}:${node.col}`);
    }

    // Resolve all values as compile-time constants
    const values: number[] = [];
    for (let i = 1; i < valuesForm.length; i++) {
      const v = tryEvalConst(valuesForm[i], this.consts);
      if (v === null) {
        throw new Error(`dolist value is not a compile-time constant at line ${valuesForm[i].line}:${valuesForm[i].col}`);
      }
      values.push(v);
    }

    const savedEnv = new Map(this.env);

    // Empty values list — no-op
    if (values.length === 0) {
      return '';
    }

    const exitBlock = this.makeBlock('enddolist');

    // Create all iteration blocks and the exit block up front
    const iterBlocks: BasicBlock[] = [];
    for (let i = 0; i < values.length; i++) {
      iterBlocks.push(this.makeBlock(`dolist_${i}`));
    }

    // Jump into the first iteration
    this.jumpTo(iterBlocks[0]);
    const firstPred = this.currentBlock;

    // Insert phi nodes at each iteration block (and exit) for outer env vars.
    // This handles the case where break/continue jumps bypass normal merge points.
    const iterPhiMaps: Map<string, string>[] = [];
    for (let i = 0; i < values.length; i++) {
      const phiMap = new Map<string, string>();
      if (i === 0) {
        // First iteration only has one predecessor — just use env directly
        // (phis would be trivial/identity, skip them)
      } else {
        // Iteration i can be reached from:
        //   - fall-through from iteration i-1
        //   - continue from iteration i-1
        // Insert phis for all outer env vars
        for (const [name, _temp] of savedEnv) {
          const phiTemp = this.freshTemp();
          iterBlocks[i].phis.push({
            dest: phiTemp,
            entries: [],  // filled when predecessors jump here
          });
          phiMap.set(name, phiTemp);
        }
      }
      iterPhiMaps.push(phiMap);
    }

    // Also insert phis at exitBlock for outer env vars
    const exitPhiMap = new Map<string, string>();
    for (const [name, _temp] of savedEnv) {
      const phiTemp = this.freshTemp();
      exitBlock.phis.push({
        dest: phiTemp,
        entries: [],  // filled when predecessors jump here
      });
      exitPhiMap.set(name, phiTemp);
    }

    for (let i = 0; i < values.length; i++) {
      this.sealBlock(iterBlocks[i]);

      // If this is not the first iteration, update env to use phi temps
      if (i > 0) {
        for (const [name, phiTemp] of iterPhiMaps[i]) {
          this.env.set(name, phiTemp);
        }
      }

      // Bind the loop variable to this iteration's value
      const valTemp = this.freshTemp(node);
      this.emit('const', valTemp, values[i]);
      this.env.set(varName, valTemp);
      this.allBindings.set(varName, valTemp);
      this.tempNames.set(valTemp, varName);

      // For break/continue: break → exitBlock, continue → next iter (or exit if last)
      const nextBlock = i + 1 < values.length ? iterBlocks[i + 1] : exitBlock;
      const headerPhiMap = i + 1 < values.length ? iterPhiMaps[i + 1] : exitPhiMap;
      this.loopStack.push({ headerBlock: nextBlock, exitBlock, headerPhiMap, exitPhiMap });

      // Lower body
      for (let j = 2; j < list.length; j++) {
        this.lowerExpr(list[j]);
      }

      // Fill phi entries at the target block before jumping
      if (!this.currentBlock.terminator) {
        const targetPhiMap = i + 1 < values.length ? iterPhiMaps[i + 1] : exitPhiMap;
        this.fillUnrolledPhis(targetPhiMap, nextBlock, this.env, this.currentBlock);
        this.jumpTo(nextBlock);
      }

      this.loopStack.pop();
    }

    this.sealBlock(exitBlock);

    // Restore env: use exit phi temps for outer vars
    this.env = savedEnv;
    for (const [name, phiTemp] of exitPhiMap) {
      this.env.set(name, phiTemp);
    }
    return '';
  }

  // Fill phi entries at an unrolled iteration block or exit block
  private fillUnrolledPhis(
    phiMap: Map<string, string>,
    targetBlock: BasicBlock,
    env: Map<string, string>,
    fromBlock: BasicBlock,
  ): void {
    for (const [varName, phiTemp] of phiMap) {
      const currentTemp = env.get(varName) ?? phiTemp;
      for (const phi of targetBlock.phis) {
        if (phi.dest === phiTemp) {
          phi.entries.push({ block: fromBlock, value: currentTemp });
          break;
        }
      }
    }
  }

  // ── break / continue ──
  private lowerBreak(): string {
    if (!this.loopStack.length) throw new Error('break outside loop');
    const { exitBlock, exitPhiMap } = this.loopStack[this.loopStack.length - 1];
    // Fill phi entries at exit block for unrolled loops
    if (exitPhiMap) {
      this.fillUnrolledPhis(exitPhiMap, exitBlock, this.env, this.currentBlock);
    }
    this.jumpTo(exitBlock);
    // Create dead block for unreachable code
    const deadBlock = this.makeBlock('dead');
    this.sealBlock(deadBlock);
    return '';
  }

  private lowerContinue(): string {
    if (!this.loopStack.length) throw new Error('continue outside loop');
    const { headerBlock, headerPhiMap } = this.loopStack[this.loopStack.length - 1];
    // Fill phi entries at next iteration block for unrolled loops
    if (headerPhiMap) {
      this.fillUnrolledPhis(headerPhiMap, headerBlock, this.env, this.currentBlock);
    }
    this.jumpTo(headerBlock);
    // Create dead block for unreachable code
    const deadBlock = this.makeBlock('dead');
    this.sealBlock(deadBlock);
    return '';
  }

  // ── tagbody / go ──
  private lowerTagbody(list: ASTNode[]): string {
    // Scan body for tags (bare symbols)
    const tags = new Map<string, BasicBlock>();
    for (let i = 1; i < list.length; i++) {
      const item = list[i];
      if (item.type === 'symbol') {
        const name = item.value;
        if (tags.has(name)) {
          throw new Error(`Duplicate tag '${name}' in tagbody at line ${item.line}:${item.col}`);
        }
        tags.set(name, this.makeBlock(`tag_${name}`));
      }
    }

    // Insert placeholder phis at each tag block for all variables in scope
    const phiMaps = new Map<string, Map<string, string>>();
    for (const [tagName, tagBlock] of tags) {
      const phiMap = new Map<string, string>();
      for (const [varName, temp] of this.env) {
        const phiTemp = this.freshTemp();
        tagBlock.phis.push({
          dest: phiTemp,
          entries: [],  // filled by jumpTo/go and fall-through
        });
        phiMap.set(varName, phiTemp);
      }
      phiMaps.set(tagName, phiMap);
    }

    this.tagbodyStack.push({ tags, phiMaps });

    // Emit body — tags become block boundaries, forms get compiled
    for (let i = 1; i < list.length; i++) {
      const item = list[i];
      if (item.type === 'symbol' && tags.has(item.value)) {
        const tagName = item.value;
        const tagBlock = tags.get(tagName)!;
        const phiMap = phiMaps.get(tagName)!;
        // Fill phi entries from the fall-through edge
        if (!this.currentBlock.terminator) {
          this.fillTagPhis(phiMap, tagBlock, this.env, this.currentBlock);
          this.jumpTo(tagBlock);
        }
        // Switch env to use phi temps
        this.sealBlock(tagBlock);
        for (const [varName, phiTemp] of phiMap) {
          this.env.set(varName, phiTemp);
        }
      } else {
        this.lowerExpr(item);
      }
    }

    this.tagbodyStack.pop();
    return '';
  }

  private fillTagPhis(
    phiMap: Map<string, string>,
    tagBlock: BasicBlock,
    env: Map<string, string>,
    fromBlock: BasicBlock,
  ): void {
    for (const [varName, phiTemp] of phiMap) {
      const currentTemp = env.get(varName) ?? phiTemp;
      for (const phi of tagBlock.phis) {
        if (phi.dest === phiTemp) {
          phi.entries.push({ block: fromBlock, value: currentTemp });
          break;
        }
      }
    }
  }

  private lowerGo(list: ASTNode[]): string {
    const tagName = (list[1] as any).value as string;
    for (let i = this.tagbodyStack.length - 1; i >= 0; i--) {
      const scope = this.tagbodyStack[i];
      if (scope.tags.has(tagName)) {
        const tagBlock = scope.tags.get(tagName)!;
        const phiMap = scope.phiMaps.get(tagName)!;
        // Fill phi entries with current env values
        this.fillTagPhis(phiMap, tagBlock, this.env, this.currentBlock);
        this.jumpTo(tagBlock);
        // Create dead block for unreachable code
        const deadBlock = this.makeBlock('dead');
        this.sealBlock(deadBlock);
        return '';
      }
    }
    throw new Error(`(go ${tagName}): no such tag in any enclosing tagbody at line ${list[1].line}:${list[1].col}`);
  }

  // ── Arithmetic ──
  private lowerArith(op: string, list: ASTNode[], node: ASTNode): string {
    // Try constant folding
    const folded = tryEvalConst(node, this.consts);
    if (folded !== null) {
      const temp = this.freshTemp(node);
      this.emit('const', temp, folded);
      return temp;
    }

    const opMap: Record<string, string> = {
      '+': 'add', '-': 'sub', '*': 'mul', '/': 'div',
      'mod': 'mod', 'and': 'and', 'or': 'or', 'xor': 'xor',
      'lshift': 'lshift', 'rshift': 'rshift',
    };
    const ssaOp = opMap[op];

    // Unary negation: (- x) → sub 0 x
    if (list.length === 2 && op === '-') {
      const a = this.resolveOperand(list[1]);
      const temp = this.freshTemp(node);
      const zero = this.freshTemp(node);
      this.emit('const', zero, 0);
      this.emit('sub', temp, zero, a);
      return temp;
    }

    // Binary / variadic
    let result = this.resolveOperand(list[1]);
    // Ensure result is in a temp (might be a constant)
    if (typeof result === 'number' || !result.startsWith('%t')) {
      const temp = this.freshTemp(node);
      if (typeof result === 'number') {
        this.emit('const', temp, result);
      } else {
        this.emit('const', temp, result);
      }
      result = temp;
    }

    for (let i = 2; i < list.length; i++) {
      const b = this.resolveOperand(list[i]);
      const temp = this.freshTemp(node);
      this.emit(ssaOp, temp, result, b);
      result = temp;
    }

    return result;
  }

  // ── random ──
  private lowerRandom(list: ASTNode[], node: ASTNode): string {
    const a = this.resolveOperand(list[1]);
    const temp = this.freshTemp(node);
    this.emit('random', temp, a);
    return temp;
  }

  // ── Sensing ──
  private lowerSenseOp(ssaOp: string, list: ASTNode[], node: ASTNode): string {
    const target = this.resolveAtom(list[1]);
    const temp = this.freshTemp(node);
    this.emit(ssaOp, temp, target);
    return temp;
  }

  private lowerSniff(list: ASTNode[], node: ASTNode): string {
    const ch = this.resolveAtom(list[1]);
    const dir = this.resolveOperand(list[2]);
    const temp = this.freshTemp(node);
    this.emit('sniff', temp, ch, dir);
    return temp;
  }

  private lowerNullaryOp(ssaOp: string, node: ASTNode): string {
    const temp = this.freshTemp(node);
    this.emit(ssaOp, temp);
    return temp;
  }

  // ── Actions ──
  private lowerMove(list: ASTNode[]): string {
    const dir = this.resolveOperand(list[1]);
    this.emit('move', null, dir);
    return '';
  }

  private lowerMark(list: ASTNode[]): string {
    const ch = this.resolveOperand(list[1]);
    const amt = this.resolveOperand(list[2]);
    this.emit('mark', null, ch, amt);
    return '';
  }

  private lowerSetTag(list: ASTNode[]): string {
    const t = this.resolveOperand(list[1]);
    this.emit('tag', null, t);
    return '';
  }

  private lowerAbort(list: ASTNode[], node: ASTNode): string {
    const code = this.resolveOperand(list[1]);
    this.emit('abort', null, code);
    return '';
  }

  private static readonly MAGIC_REG_MAP: Record<string, number> = {
    'rD_FD': 8, 'rD_CL': 9, 'rD_PX': 10, 'rD_PY': 11, 'rD_PC': 12,
  };

  private lowerReg(list: ASTNode[], node: ASTNode): string {
    if (list.length !== 2 || list[1].type !== 'symbol') {
      throw new Error(`(reg <name>) requires exactly one symbol argument at line ${node.line}:${node.col}`);
    }
    const name = (list[1] as any).value as string;
    const idx = SSALowering.MAGIC_REG_MAP[name];
    if (idx === undefined) {
      const valid = Object.keys(SSALowering.MAGIC_REG_MAP).join(', ');
      throw new Error(`Unknown magic register "${name}" at line ${node.line}:${node.col}. Valid: ${valid}`);
    }
    const temp = this.freshTemp(node);
    this.emit('reg', temp, idx);
    return temp;
  }

  // ── Comparisons ──

  private lowerComparison(op: string, list: ASTNode[], node: ASTNode): string {
    // Produce a value: 1 if true, 0 if false
    const a = this.resolveOperand(list[1]);
    const b = this.resolveOperand(list[2]);

    const cmpMap: Record<string, CmpOp> = {
      '=': 'eq', '!=': 'ne', '>': 'gt', '<': 'lt', '>=': 'ge', '<=': 'le',
    };
    const cmpOp = cmpMap[op];

    const thenBlock = this.makeBlock('cmp_true');
    const elseBlock = this.makeBlock('cmp_false');
    const mergeBlock = this.makeBlock('cmp_end');

    this.branchTo(cmpOp, a, b, thenBlock, elseBlock);

    this.sealBlock(thenBlock);
    const trueTemp = this.freshTemp(node);
    this.emit('const', trueTemp, 1);
    this.jumpTo(mergeBlock);
    const thenExit = this.currentBlock;

    this.sealBlock(elseBlock);
    const falseTemp = this.freshTemp(node);
    this.emit('const', falseTemp, 0);
    this.jumpTo(mergeBlock);
    const elseExit = this.currentBlock;

    this.sealBlock(mergeBlock);
    const resultTemp = this.freshTemp(node);
    mergeBlock.phis.push({
      dest: resultTemp,
      entries: [
        { block: thenExit, value: trueTemp },
        { block: elseExit, value: falseTemp },
      ],
    });

    return resultTemp;
  }

  private lowerNot(list: ASTNode[], node: ASTNode): string {
    // (not x) → (= x 0)
    const inner = this.resolveOperand(list[1]);
    const thenBlock = this.makeBlock('not_true');
    const elseBlock = this.makeBlock('not_false');
    const mergeBlock = this.makeBlock('not_end');

    this.branchTo('eq', inner, 0, thenBlock, elseBlock);

    this.sealBlock(thenBlock);
    const trueTemp = this.freshTemp(node);
    this.emit('const', trueTemp, 1);
    this.jumpTo(mergeBlock);
    const thenExit = this.currentBlock;

    this.sealBlock(elseBlock);
    const falseTemp = this.freshTemp(node);
    this.emit('const', falseTemp, 0);
    this.jumpTo(mergeBlock);
    const elseExit = this.currentBlock;

    this.sealBlock(mergeBlock);
    const resultTemp = this.freshTemp(node);
    mergeBlock.phis.push({
      dest: resultTemp,
      entries: [
        { block: thenExit, value: trueTemp },
        { block: elseExit, value: falseTemp },
      ],
    });

    return resultTemp;
  }

  private lowerZeroQ(list: ASTNode[], node: ASTNode): string {
    // (zero? x) → (= x 0)
    return this.lowerComparison('=', [list[0], list[1], { type: 'number', value: 0, line: node.line, col: node.col }], node);
  }

  // ── Condition branch generation ──
  // Compiles a condition and branches to thenBlock/elseBlock

  private lowerCondBranch(cond: ASTNode, thenBlock: BasicBlock, elseBlock: BasicBlock): void {
    if (cond.type !== 'list') {
      const val = this.resolveOperand(cond);
      // Ensure val is in a temp
      let temp: string;
      if (typeof val === 'number') {
        temp = this.freshTemp(cond);
        this.emit('const', temp, val);
      } else if (!val.startsWith('%t')) {
        temp = this.freshTemp(cond);
        this.emit('const', temp, val);
      } else {
        temp = val;
      }
      this.branchTo('ne', temp, 0, thenBlock, elseBlock);
      return;
    }

    const list = cond.value;
    if (list.length === 0) return;
    const op = list[0].type === 'symbol' ? list[0].value : null;

    const cmpMap: Record<string, CmpOp> = {
      '=': 'eq', '!=': 'ne', '>': 'gt', '<': 'lt', '>=': 'ge', '<=': 'le',
    };

    if (op && cmpMap[op]) {
      const a = this.resolveOperand(list[1]);
      const b = this.resolveOperand(list[2]);
      this.branchTo(cmpMap[op], a, b, thenBlock, elseBlock);
      return;
    }

    if (op === 'not') {
      // Flip then/else
      this.lowerCondBranch(list[1], elseBlock, thenBlock);
      return;
    }

    if (op === 'zero?') {
      const a = this.resolveOperand(list[1]);
      this.branchTo('eq', a, 0, thenBlock, elseBlock);
      return;
    }

    if (op === 'and') {
      // All must be true → then. Any false → else.
      for (let i = 1; i < list.length - 1; i++) {
        const nextBlock = this.makeBlock('and_next');
        this.lowerCondBranch(list[i], nextBlock, elseBlock);
        this.sealBlock(nextBlock);
      }
      this.lowerCondBranch(list[list.length - 1], thenBlock, elseBlock);
      return;
    }

    if (op === 'or') {
      // Any true → then. All false → else.
      for (let i = 1; i < list.length - 1; i++) {
        const nextBlock = this.makeBlock('or_next');
        this.lowerCondBranch(list[i], thenBlock, nextBlock);
        this.sealBlock(nextBlock);
      }
      this.lowerCondBranch(list[list.length - 1], thenBlock, elseBlock);
      return;
    }

    if (op === 'carrying?') {
      const temp = this.freshTemp(cond);
      this.emit('carrying', temp);
      this.branchTo('ne', temp, 0, thenBlock, elseBlock);
      return;
    }

    // General: compile to value, branch on nonzero
    const val = this.lowerExpr(cond);
    this.branchTo('ne', val, 0, thenBlock, elseBlock);
  }

  // ── Phi helpers ──

  private insertPhis(
    env1: Map<string, string>,
    env2: Map<string, string>,
    block1: BasicBlock,
    block2: BasicBlock,
    envBefore: Map<string, string>,
  ): void {
    // For any variable whose temp differs between branches, insert a phi
    for (const [name, temp1] of env1) {
      const temp2 = env2.get(name);
      if (temp2 !== undefined && temp1 !== temp2) {
        const phiTemp = this.freshTemp();
        this.currentBlock.phis.push({
          dest: phiTemp,
          entries: [
            { block: block1, value: temp1 },
            { block: block2, value: temp2 },
          ],
        });
        this.env.set(name, phiTemp);
        this.allBindings.set(name, phiTemp);
        this.tempNames.set(phiTemp, name);
      }
    }
  }

  private insertPhisMulti(
    branches: { env: Map<string, string>; exitBlock: BasicBlock }[],
    envBefore: Map<string, string>,
  ): void {
    // Collect all variables that changed in any branch
    const changedVars = new Set<string>();
    for (const { env } of branches) {
      for (const [name, temp] of env) {
        const before = envBefore.get(name);
        if (before !== undefined && before !== temp) {
          changedVars.add(name);
        }
      }
    }

    for (const name of changedVars) {
      const phiTemp = this.freshTemp();
      const entries: { block: BasicBlock; value: string }[] = [];
      for (const { env, exitBlock } of branches) {
        const temp = env.get(name) ?? envBefore.get(name)!;
        entries.push({ block: exitBlock, value: temp });
      }
      this.currentBlock.phis.push({ dest: phiTemp, entries });
      this.env.set(name, phiTemp);
      this.allBindings.set(name, phiTemp);
      this.tempNames.set(phiTemp, name);
    }
  }

  private insertLoopHeaderPhis(
    headerBlock: BasicBlock,
    env: Map<string, string>,
    predBlock: BasicBlock,
  ): Map<string, string> {
    // Create placeholder phis for all variables in scope
    const phiMap = new Map<string, string>();
    for (const [name, temp] of env) {
      const phiTemp = this.freshTemp();
      headerBlock.phis.push({
        dest: phiTemp,
        entries: [{ block: predBlock, value: temp }],
        // The back-edge entry will be filled later
      });
      this.env.set(name, phiTemp);
      this.allBindings.set(name, phiTemp);
      this.tempNames.set(phiTemp, name);
      phiMap.set(name, phiTemp);
    }
    return phiMap;
  }

  private fillLoopPhis(
    phiMap: Map<string, string>,
    env: Map<string, string>,
    exitBlock: BasicBlock,
  ): void {
    // Fill in the back-edge phi entries
    for (const [name, phiTemp] of phiMap) {
      const currentTemp = env.get(name) ?? phiTemp;
      // Find the phi node and add the back-edge entry
      for (const phi of this.blocks.find(b => b.phis.some(p => p.dest === phiTemp))!.phis) {
        if (phi.dest === phiTemp) {
          phi.entries.push({ block: exitBlock, value: currentTemp });
          break;
        }
      }
    }
  }
}

// ─── Pretty Printer (for debugging) ────────────────────────

export function printSSA(program: SSAProgram): string {
  const lines: string[] = [];
  for (const block of program.blocks) {
    lines.push(`${block.label}:`);
    // Preds
    if (block.preds.length > 0) {
      lines.push(`  ; preds: ${block.preds.map(b => b.label).join(', ')}`);
    }
    // Phis
    for (const phi of block.phis) {
      const entries = phi.entries.map(e => `[${e.block.label}: ${e.value}]`).join(', ');
      lines.push(`  ${phi.dest} = phi ${entries}`);
    }
    // Instructions
    for (const instr of block.instrs) {
      if (instr.dest) {
        lines.push(`  ${instr.dest} = ${instr.op} ${instr.args.join(' ')}`);
      } else {
        lines.push(`  ${instr.op} ${instr.args.join(' ')}`);
      }
    }
    // Terminator
    if (block.terminator) {
      const term = block.terminator;
      if (term.op === 'jmp') {
        lines.push(`  jmp ${term.target.label}`);
      } else {
        lines.push(`  br_cmp ${term.cmpOp} ${term.a} ${term.b} ${term.thenBlock.label} ${term.elseBlock.label}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ─── Public API ─────────────────────────────────────────────

export function lowerToSSA(
  forms: ASTNode[],
  tags: TagDef[],
  consts: Map<string, string>,
  sourceFile = '',
): SSAProgram {
  const lowering = new SSALowering(tags, consts, sourceFile);
  return lowering.lower(forms);
}
