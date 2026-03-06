#!/usr/bin/env bash
# @describe Moment Swarm
# https://dev.moment.com/swarm

set -eu


# @cmd Compile alisp to ant
# @arg file! alisp file
compile() {
	target=$(basename "${argc_file:?}" .alisp).ant
	node antlisp.js "${argc_file:?}" > "$target"
	pbcopy < "$target"
	echo "Compiled and copied $target"
}

if ! command -v argc >/dev/null; then
	echo "This command requires argc. Install from https://github.com/sigoden/argc" >&2
	exit 100
fi
eval "$(argc --argc-eval "$0" "$@")"
