#!/bin/zsh
# Clears the "app from the internet" quarantine so Tube Stash.app can open.
cd "$(dirname "$0")"
xattr -cr .
osascript -e 'display notification "macOS warning cleared. Open Tube Stash.app." with title "Tube Stash"'
open .
