#!/bin/sh
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root/server"
exec npm ci --include=dev --no-audit --no-fund
