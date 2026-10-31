#!/bin/sh
# Prints the header object Claude Code merges into each connection.
printf '{"Authorization":"Bearer %s"}' "$(cat "$HOME/.config/tower/token")"
