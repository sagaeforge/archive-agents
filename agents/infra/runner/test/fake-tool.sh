#!/usr/bin/env bash
# Stands in for every external tool the runner scripts call. The tests link it
# under each tool's name in a directory that is the whole of PATH, so nothing
# can reach a node or GitHub. Each call is recorded in $FAKE_LOG and answered
# the way the real tool would answer.
#
# Log format: fields end in \037 and records end in \036, so arguments may hold
# newlines. The last field of a record is the stdin the tool received.
set -uo pipefail

# A test can forbid the scripts any local file write through a soft size limit
# of zero. The fakes stand outside that promise: they keep the log.
ulimit -S -f "$(ulimit -H -f)"

tool=${0##*/}

record() {
  local stdin=$1 entry
  shift
  entry=$(printf '%s\037' "$tool" "$@" && printf '%s\036' "$stdin")
  printf '%s' "$entry" >>"$FAKE_LOG"
}

# ssh leaves stdin for the remote command. Running the remote string in a shell
# proves that the scripts quote it correctly.
if [[ $tool == ssh ]]; then
  record "" "$@"
  exec bash -c "${*: -1}"
fi

stdin=""
if [[ ! -t 0 ]]; then
  IFS= read -r -d '' stdin
fi
record "$stdin" "$@"

# FAKE_FAIL_AFTER holds the failure back until that text has reached the log, for a
# command that a script runs more than once. FAKE_FAIL_FIRST ends it after that many
# failures, for a command that a script is meant to retry. FAKE_FAIL_ALSO fails a second
# command, for what a script does after the first failure.
forced_failure() {
  [[ -z ${FAKE_FAIL_ALSO:-} || "$tool $*" != *"$FAKE_FAIL_ALSO"* ]] || return 0
  [[ -n ${FAKE_FAIL_MATCH:-} && "$tool $*" == *"$FAKE_FAIL_MATCH"* ]] || return 1
  [[ -z ${FAKE_FAIL_AFTER:-} || $(<"$FAKE_LOG") == *"$FAKE_FAIL_AFTER"* ]] || return 1
  [[ -n ${FAKE_FAIL_FIRST:-} ]] || return 0

  local counter=$FAKE_LOG.failures failed=0
  [[ ! -e $counter ]] || failed=$(<"$counter")
  printf '%s' "$((failed + 1))" >"$counter"
  ((failed < FAKE_FAIL_FIRST))
}

if forced_failure "$@"; then
  printf 'fake %s: forced failure\n' "$tool" >&2
  exit 1
fi

# All three nodes online, in the shape of GET /cluster/status.
ALL_NODES_ONLINE='[{"type":"cluster","id":"cluster","name":"test","nodes":3,"quorate":1,"version":3},{"type":"node","id":"node/n1","name":"n1","nodeid":1,"local":1,"level":"","online":1,"ip":"192.0.2.1"},{"type":"node","id":"node/n2","name":"n2","nodeid":2,"local":0,"level":"","online":1,"ip":"192.0.2.1"},{"type":"node","id":"node/n3","name":"n3","nodeid":3,"local":0,"level":"","online":1,"ip":"192.0.2.1"}]'

case $tool in
  gh)
    case "$*" in
      *registration-token*) printf '%s\n' "$FAKE_REGISTRATION_TOKEN" ;;
      *permissions.admin*) printf '%s\n' "${FAKE_GH_ADMIN-true}" ;;
      *actions/runners*) printf '%s\n' "${FAKE_RUNNER_STATE:-online false}" ;;
    esac
    ;;
  hostname)
    printf '%s\n' "$FAKE_HOSTNAME"
    ;;
  pveam)
    if [[ $1 == available ]]; then
      printf 'system          %s\n' \
        debian-12-standard_12.12-1_amd64.tar.zst \
        debian-13-standard_13.6-1_amd64.tar.zst \
        debian-13-standard_13.6-1_arm64.tar.zst
    fi
    ;;
  pvesh)
    if [[ "$*" == *cluster/status* ]]; then
      printf '%s\n' "${FAKE_CLUSTER_STATUS:-$ALL_NODES_ONLINE}"
    fi
    ;;
  pveum)
    if [[ "$*" == "user token add"* ]]; then
      printf '{"full-tokenid":"%s!%s","info":{"privsep":1},"value":"%s"}\n' "$3" "$4" "$FAKE_PVE_SECRET"
    fi
    ;;
  curl)
    if [[ "$*" == */access/permissions* ]]; then
      printf '%s\n' "$FAKE_PERMISSIONS"
    else
      printf '{"data":{"version":"9.2.2"}}\n'
    fi
    ;;
  pct)
    case "$*" in
      config*) printf '%s\n' "${FAKE_PCT_CONFIG:-unprivileged: 1}" ;;
      *"stat -c"*) printf '%s\n' "${FAKE_TOKEN_FILE_STAT:-root:runner 640}" ;;
    esac
    ;;
esac
exit 0
