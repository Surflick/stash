#!/bin/zsh
# Clears the "app from the internet" quarantine so Stash.app can open.
cd "$(dirname "$0")"
xattr -cr .
osascript -e 'display notification "macOS warning cleared. Open Stash.app." with title "Stash"'
open .
