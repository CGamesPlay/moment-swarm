#!/usr/bin/env bash
# @describe Moment Swarm
# https://dev.moment.com/swarm

set -eu

# @cmd Compile alisp to ant
# @arg    file!           alisp file
# @flag   --copy          Copy the result
# @option -D --define*    Override a const value, e.g. -D EXPLORE_TIMEOUT=400
compile() {
	local -a dflags=()
	for d in ${argc_define+"${argc_define[@]}"}; do
		dflags+=(-D "$d")
	done
	local asm
	asm="$(node antlisp.js ${dflags+"${dflags[@]}"} "${argc_file:?}")"
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
# @option -D --define*  Override a const value, e.g. -D EXPLORE_TIMEOUT=400
test() {
	local -a dflags=()
	for d in ${argc_define+"${argc_define[@]}"}; do
		dflags+=(-D "$d")
	done
	local asm
	asm="$(node antlisp.js ${dflags+"${dflags[@]}"} "${argc_file:?}")" || exit $?
	echo "$asm" | node run.js ${argc_map+-m "$argc_map"}
}

# @cmd Run compiler tests
selftest() {
	node antlisp.test.js
}

# @cmd Run alisp unit tests
# @arg  file!           .unit.alisp test file
# @flag -v --verbose    Show compiled assembly and register state for each test
unit() {
	node antlisp.unit.js "${argc_file:?}" ${argc_verbose+--verbose}
}

if ! command -v argc >/dev/null; then
	echo "This command requires argc. Install from https://github.com/sigoden/argc" >&2
	exit 100
fi
eval "$(argc --argc-eval "$0" "$@")"
