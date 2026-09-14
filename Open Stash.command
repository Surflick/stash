#!/bin/zsh
cd "$(dirname "$0")"
export STASH_ROOT="$PWD"
export PATH="/opt/homebrew/bin:/opt/homebrew/opt/node@22/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
exec "$STASH_ROOT/scripts/start.sh"
