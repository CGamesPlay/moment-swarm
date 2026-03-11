#!/usr/bin/env bash
# @describe Moment Swarm
# https://dev.moment.com/swarm

set -eu

# @cmd Compile alisp to ant
# @arg    file!           alisp file
# @flag   --copy          Copy the result
# @flag   --dump-ssa      Dump the SSA of the program
# @flag   --no-debug      Compile with DEBUG=0 (production mode)
# @option -D --define*    Override a const value, e.g. -D EXPLORE_TIMEOUT=400
compile() {
	local -a flags=()
	for d in ${argc_define+"${argc_define[@]}"}; do
		flags+=(-D "$d")
	done
	if [[ ${argc_no_debug+1} ]]; then
		flags+=(-D DEBUG=0)
	else
		flags+=(-D DEBUG=1)
	fi
	if [[ ${argc_dump_ssa+1} ]]; then
		flags+=(--dump-ssa)
	fi
	local asm
	asm="$(npx --prefix compiler tsx compiler/antlisp.ts ${flags+"${flags[@]}"} "${argc_file:?}")"
	if [[ ${argc_copy+1} ]]; then
		echo "$asm" | pbcopy
		echo "Compiled and copied $argc_file"
	else
		echo "$asm"
	fi
}

# @cmd Run an alisp file through the simulator
# @arg  file!           alisp file
# @option -m --map      Run only a specific map (type like "gauntlet" or full name like "gauntlet-41jczs")
# @option -s --seed     Global map seed (default: 42)
# @option -o --max-ops  Max ops per ant per tick (default: 64)
# @option -D --define*  Override a const value, e.g. -D EXPLORE_TIMEOUT=400
# @flag      --no-debug Compile with DEBUG=0 and reject ABORT opcodes
test() {
	local -a flags=()
	for d in ${argc_define+"${argc_define[@]}"}; do
		flags+=(-D "$d")
	done
	local -a run_flags=(--allow-abort)
	if [[ ${argc_no_debug+1} ]]; then
		flags+=(-D DEBUG=0)
		run_flags=()
	fi
	local asm
	asm="$(npx --prefix compiler tsx compiler/antlisp.ts ${flags+"${flags[@]}"} "${argc_file:?}")" || exit $?
	echo "$asm" | npx --prefix compiler tsx compiler/run.ts \
		${argc_map+-m "$argc_map"} ${argc_seed+-s "$argc_seed"} \
		${argc_max_ops+-o "$argc_max_ops"} \
		${run_flags+"${run_flags[@]}"}
}

# @cmd Run alisp unit tests
# @arg  file!           .unit.alisp test file
# @flag -v --verbose    Show compiled assembly and register state for each test
# @option -D --define*  Override a const value (e.g. -D DEBUG=1)
unit() {
	local -a flags=()
	for d in ${argc_define+"${argc_define[@]}"}; do
		flags+=(-D "$d")
	done
	npx --prefix compiler tsx compiler/antlisp.unit.js \
		${flags+"${flags[@]}"} "${argc_file:?}" ${argc_verbose+--verbose}
}

# @cmd Run hyperparameter optimization dashboard
optimize() {
	exec marimo run --sandbox --watch hyperparameters.py
}

# @cmd Run all compiler tests (unit, self-test, type-check)
# @flag -v --verbose    Show detailed output
selftest() {
	local output rc f verbose=${argc_verbose+1}

	if [[ $verbose ]]; then
		echo "═══ TypeScript ═══"
		npx --prefix compiler tsc -p compiler --noEmit
		echo "tsc: OK"
	else
		npx --prefix compiler tsc -p compiler --noEmit >/dev/null 2>&1 || exit $?
		echo "  ✓ TypeScript"
	fi

	if [[ $verbose ]]; then
		echo "═══ Compiler tests ═══"
	fi
	rc=0
	for f in compiler/*.test.ts compiler/antlisp.test.js; do
		[[ -f "$f" ]] || continue
		if [[ $verbose ]]; then
			rc=0; output="$(npx --prefix compiler tsx "$f" 2>&1)" || rc=$?
			echo "$output"
		else
			rc=0; npx --prefix compiler tsx "$f" >/dev/null 2>&1 || rc=$?
		fi
		[[ $rc -eq 0 ]] || exit $rc
	done
	[[ $verbose ]] || echo "  ✓ Compiler tests"

	if [[ $verbose ]]; then
		echo "═══ Runtime unit tests ═══"
	fi
	rc=0
	for f in compiler/*.unit.alisp; do
		[[ -f "$f" ]] || continue
		if [[ $verbose ]]; then
			echo "── $f ──"
			rc=0; output="$(npx --prefix compiler tsx compiler/antlisp.unit.js \
				"$f" 2>&1)" || rc=$?
			echo "$output"
		else
			rc=0; npx --prefix compiler tsx compiler/antlisp.unit.js \
				"$f" >/dev/null 2>&1 || rc=$?
		fi
		[[ $rc -eq 0 ]] || exit $rc
	done
	[[ $verbose ]] || echo "  ✓ Antlisp unit tests"

	if [[ $verbose ]]; then
		echo "═══ Program unit tests ═══"
	fi
	rc=0
	for f in programs/*.unit.alisp; do
		[[ -f "$f" ]] || continue
		if [[ $verbose ]]; then
			echo "── $f ──"
			rc=0; output="$(npx --prefix compiler tsx compiler/antlisp.unit.js \
				"$f" 2>&1)" || rc=$?
			echo "$output"
		else
			rc=0; npx --prefix compiler tsx compiler/antlisp.unit.js \
				"$f" >/dev/null 2>&1 || rc=$?
		fi
		[[ $rc -eq 0 ]] || exit $rc
	done
	[[ $verbose ]] || echo "  ✓ Program unit tests"

	if [[ $verbose ]]; then
		echo "═══ Program compilation ═══"
	fi
	rc=0
	for f in programs/*.alisp; do
		[[ -f "$f" ]] || continue
		# Skip inc.alisp and unit.alisp files
		[[ "$f" == *"/inc.alisp" || "$f" == *".unit.alisp" ]] && continue
		if [[ $verbose ]]; then
			echo "── $f ──"
			rc=0; output="$(npx --prefix compiler tsx compiler/antlisp.ts "$f" 2>&1)" || rc=$?
			if [[ $rc -eq 0 ]]; then
				echo "OK ($(echo "$output" | wc -l) instructions)"
			else
				echo "FAILED"
				echo "$output"
			fi
		else
			rc=0; npx --prefix compiler tsx compiler/antlisp.ts "$f" >/dev/null 2>&1 || rc=$?
		fi
		[[ $rc -eq 0 ]] || exit $rc
	done
	[[ $verbose ]] || echo "  ✓ Program compilation"
}

if ! command -v argc >/dev/null; then
	echo "This command requires argc. Install from https://github.com/sigoden/argc" >&2
	exit 100
fi
eval "$(argc --argc-eval "$0" "$@")"
