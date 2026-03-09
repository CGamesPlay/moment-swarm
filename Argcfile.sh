#!/usr/bin/env bash
# @describe Moment Swarm
# https://dev.moment.com/swarm

set -eu

# @cmd Compile alisp to ant
# @arg    file!           alisp file
# @flag   --copy          Copy the result
# @flag   --dump-ssa      Dump the SSA of the program
# @option -D --define*    Override a const value, e.g. -D EXPLORE_TIMEOUT=400
compile() {
	local -a flags=()
	for d in ${argc_define+"${argc_define[@]}"}; do
		flags+=(-D "$d")
	done
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
# @option -m --map      Run only a specific map (e.g. "open-38bs6g")
# @option -o --max-ops  Max ops per ant per tick (default: 64)
# @option -D --define*  Override a const value, e.g. -D EXPLORE_TIMEOUT=400
test() {
	local -a flags=()
	for d in ${argc_define+"${argc_define[@]}"}; do
		flags+=(-D "$d")
	done
	local asm
	asm="$(npx --prefix compiler tsx compiler/antlisp.ts ${flags+"${flags[@]}"} "${argc_file:?}")" || exit $?
	echo "$asm" | npx --prefix compiler tsx compiler/run.ts ${argc_map+-m "$argc_map"} ${argc_max_ops+-o "$argc_max_ops"}
}

# @cmd Run alisp unit tests
# @arg  file!           .unit.alisp test file
# @flag -v --verbose    Show compiled assembly and register state for each test
unit() {
	npx --prefix compiler tsx compiler/antlisp.unit.js "${argc_file:?}" ${argc_verbose+--verbose}
}

# @cmd Run all compiler tests (unit, self-test, type-check)
# @flag -v --verbose  Show individual test names
selftest() {
	local output rc f

	echo "═══ Compiler tests ═══"
	for f in compiler/*.test.ts compiler/antlisp.test.js; do
		[[ -f "$f" ]] || continue
		rc=0; output="$(npx --prefix compiler tsx "$f" 2>&1)" || rc=$?
		if [[ ${argc_verbose+1} ]]; then
			echo "$output"
		else
			echo "$output" | grep -v '^✓ '
		fi
		[[ $rc -eq 0 ]] || exit $rc
	done

	echo "═══ Runtime unit tests ═══"
	for f in compiler/*.unit.alisp; do
		[[ -f "$f" ]] || continue
		echo "── $f ──"
		rc=0; output="$(npx --prefix compiler tsx compiler/antlisp.unit.js "$f" 2>&1)" || rc=$?
		if [[ ${argc_verbose+1} ]]; then
			echo "$output"
		else
			echo "$output" | grep -v '^  ✓'
		fi
		[[ $rc -eq 0 ]] || exit $rc
	done

	echo "═══ TypeScript ═══"
	npx --prefix compiler tsc -p compiler --noEmit
	echo "tsc: OK"
}

if ! command -v argc >/dev/null; then
	echo "This command requires argc. Install from https://github.com/sigoden/argc" >&2
	exit 100
fi
eval "$(argc --argc-eval "$0" "$@")"
