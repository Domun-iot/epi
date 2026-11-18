#!/bin/sh
root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd) || exit 1
result=0
report=''
for target in linux ubuntu android cli web server; do
    printf '\n===== Building %s =====\n' "$target"
    if sh "$root/run/build/$target.sh"; then
        status=OK
    else
        status=FAILED
        result=1
    fi
    report="$report$target: $status
"
done
printf '\n===== Build report =====\n%s' "$report"
exit "$result"
