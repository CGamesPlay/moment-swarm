#!/usr/bin/env node
"use strict";

const fs = require("fs");
const engine = require("./node-engine");

// ─── Usage ───────────────────────────────────────────────────────────────────

const USAGE = `
Usage: node run.js [options] [file.ant]

Run a SWARM ant program against evaluation maps and report scores.

Arguments:
  file.ant              Assembly source file (reads stdin if omitted)

Options:
  -m, --map <name>      Run only the named map (e.g. "open-38bs6g")
  -s, --seed <n>        Global map seed (default: 42)
  -n, --maps <n>        Number of eval maps to generate (default: 12)
  -t, --ticks <n>       Max ticks per map (default: 2000)
  -a, --ants <n>        Number of ants (default: 200)
  -l, --list            List generated map names and exit
  -v, --verbose         Print per-tick progress every 100 ticks
  -q, --quiet           Only print the final score number
  -h, --help            Show this help
`.trim();

// ─── Arg parsing ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let file = null;
let mapFilter = null;
let seed = 42;
let numMaps = 12;
let maxTicks = 2000;
let antCount = 200;
let listMaps = false;
let verbose = false;
let quiet = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  switch (arg) {
    case "-h": case "--help":
      console.log(USAGE);
      process.exit(0);
    case "-m": case "--map":
      mapFilter = args[++i];
      break;
    case "-s": case "--seed":
      seed = parseInt(args[++i], 10);
      break;
    case "-n": case "--maps":
      numMaps = parseInt(args[++i], 10);
      break;
    case "-t": case "--ticks":
      maxTicks = parseInt(args[++i], 10);
      break;
    case "-a": case "--ants":
      antCount = parseInt(args[++i], 10);
      break;
    case "-l": case "--list":
      listMaps = true;
      break;
    case "-v": case "--verbose":
      verbose = true;
      break;
    case "-q": case "--quiet":
      quiet = true;
      break;
    default:
      if (arg.startsWith("-")) {
        console.error(`Unknown option: ${arg}`);
        console.error('Try --help for usage.');
        process.exit(1);
      }
      file = arg;
  }
}

// ─── List maps mode ──────────────────────────────────────────────────────────

if (listMaps) {
  const maps = engine.generateEvalMaps(128, 128, seed, numMaps);
  for (let i = 0; i < maps.length; i++) {
    const m = maps[i];
    console.log(`${String(i + 1).padStart(3)}  ${m.name.padEnd(24)} food: ${String(m.totalFood).padStart(5)}  nest: ${m.nestX},${m.nestY}`);
  }
  process.exit(0);
}

// ─── Read source ─────────────────────────────────────────────────────────────

let source;
if (file) {
  if (!fs.existsSync(file)) {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }
  source = fs.readFileSync(file, "utf8");
} else if (!process.stdin.isTTY) {
  source = fs.readFileSync(0, "utf8");
} else {
  console.error("No input file. Pass a .ant file or pipe to stdin.");
  console.error('Try --help for usage.');
  process.exit(1);
}

// ─── Assemble ────────────────────────────────────────────────────────────────

let program;
try {
  program = engine.parseAssembly(source);
} catch (e) {
  if (e instanceof engine.AssemblyError) {
    console.error(`Assembly error: ${e.message}`);
    process.exit(1);
  }
  throw e;
}

if (!quiet) {
  console.error(`Assembled ${program.instructions.length} instructions`);
}

// ─── Generate maps ───────────────────────────────────────────────────────────

const config = { ...engine.DEFAULT_CONFIG, maxTicks, antCount };
const allMaps = engine.generateEvalMaps(config.mapWidth, config.mapHeight, seed, numMaps);

let maps;
if (mapFilter) {
  const match = allMaps.find(m => m.name === mapFilter);
  if (!match) {
    console.error(`Map "${mapFilter}" not found. Available maps:`);
    for (const m of allMaps) console.error(`  ${m.name}`);
    process.exit(1);
  }
  maps = [match];
} else {
  maps = allMaps;
}

// ─── Run simulation ─────────────────────────────────────────────────────────

const results = [];

for (let i = 0; i < maps.length; i++) {
  const map = maps[i];
  const world = engine.createWorld(engine.cloneMap(map), program, config);
  const t0 = Date.now();

  for (let t = 0; t < maxTicks; t++) {
    engine.runTick(world, config);
    if (verbose && (t + 1) % 100 === 0) {
      console.error(`  [${map.name}] tick ${t + 1}/${maxTicks}  collected: ${world.foodCollected}/${map.totalFood}`);
    }
  }

  const elapsed = Date.now() - t0;
  const collected = world.foodCollected;
  const total = map.totalFood;
  const ratio = total > 0 ? collected / total : 0;
  results.push({ name: map.name, collected, total, ratio, elapsed });

  if (!quiet) {
    console.error(`  ${map.name.padEnd(24)} ${String(collected).padStart(5)}/${String(total).padStart(5)}  (${(ratio * 100).toFixed(1).padStart(5)}%)  ${elapsed}ms`);
  }
}

// ─── Summary ─────────────────────────────────────────────────────────────────

const avgRatio = results.reduce((s, r) => s + r.ratio, 0) / results.length;
const score = Math.round(avgRatio * 1000);
const totalElapsed = results.reduce((s, r) => s + r.elapsed, 0);

if (quiet) {
  console.log(score);
} else {
  console.error("");
  console.log(`Score: ${score}/1000  (${(avgRatio * 100).toFixed(1)}% avg collection, ${results.length} map${results.length > 1 ? "s" : ""}, ${totalElapsed}ms)`);
}
