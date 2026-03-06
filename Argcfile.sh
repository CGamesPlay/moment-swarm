#!/usr/bin/env bash
# @describe Moment Swarm
# https://dev.moment.com/swarm

set -eu

# @cmd Compile alisp to ant
# @arg  file!   alisp file
# @flag --copy  Copy the result
compile() {
	local asm
	asm="$(node antlisp.js "${argc_file:?}")"
	if [[ ${argc_copy+1} ]]; then
		echo "$asm" | pbcopy
		echo "Compiled and copied $argc_file"
	else
		echo "$asm"
	fi
}

# @cmd Run compiler tests
selftest() {
	node antlisp.test.js
}

if ! command -v argc >/dev/null; then
	echo "This command requires argc. Install from https://github.com/sigoden/argc" >&2
	exit 100
fi
eval "$(argc --argc-eval "$0" "$@")"
