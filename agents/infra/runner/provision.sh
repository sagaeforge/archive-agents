#!/usr/bin/env bash
# Provisions the self-hosted GitHub Actions runner: an unprivileged LXC on a
# Proxmox node, locked down by nftables, then registered to this repository.
# The firewall is applied and checked first, so a runner without its network
# limits never takes a job.
#
# Runs on an admin machine with root SSH access to the node and a gh CLI that
# has admin rights on the repository. --dry-run prints the commands and runs
# none of them. The PVE token is a separate step: run issue-token.sh afterwards.
set -euo pipefail

REPO="sagaeforge/sagae-claude-plugins"
RUNNER_NAME="pve-runner-01"
RUNNER_LABEL="proxmox"
RUNNER_DIR="/home/runner/actions-runner"

# Pinned runner release. Take the checksum from the actions/runner release notes
# and confirm it against the asset digest the GitHub API reports.
RUNNER_VERSION="2.338.2"
RUNNER_SHA256="baebf204307bac6193480852732f0aba2ae97b6c5597c244f4d5558390147c40"
RUNNER_TARBALL="actions-runner-linux-x64-$RUNNER_VERSION.tar.gz"
RUNNER_URL="https://github.com/actions/runner/releases/download/v$RUNNER_VERSION/$RUNNER_TARBALL"

TEMPLATE_PREFIX="debian-13-standard_"
TEMPLATE_STORAGE="local"
ROOTFS_STORAGE="local-lvm"
DISK_GB=32
CORES=4
MEMORY_MB=4096
BRIDGE="vmbr0"
LAN_GATEWAY="192.0.2.1"
# Must stay in DNS_SERVERS of nftables.conf.
NAMESERVER="1.1.1.1"

RETRIES=30
RETRY_DELAY=5
SSH_CMD=(ssh -o BatchMode=yes -o ConnectTimeout=10)

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
NFT_CONF="$SCRIPT_DIR/nftables.conf"

NODE=""
VMID=""
SSH_HOST=""
IP="dhcp"
TEMPLATE=""
DRY_RUN=0
LXC_CREATED=0
STEP=0
NODE_IPS=()

usage() {
  cat <<'EOF'
Usage: provision.sh --node <pve-node> --vmid <id> [options]

Required:
  --node <name>      Proxmox node that hosts the LXC, such as pve-node
  --vmid <id>        VMID for the new LXC, free across the whole cluster

Options:
  --host <ssh-host>  SSH target for the node (default: the --node value)
  --ip <dhcp|cidr>   Address of eth0 (default: dhcp)
  --template <file>  LXC template (default: newest debian-13-standard amd64)
  --dry-run          Print the commands and run none of them
  -h, --help         Show this help
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

usage_error() {
  printf 'error: %s\n\n' "$*" >&2
  usage >&2
  exit 2
}

need_value() {
  (($# >= 2)) || usage_error "$1 needs a value"
}

parse_args() {
  while (($# > 0)); do
    case $1 in
      --node)
        need_value "$@"
        NODE=$2
        shift 2
        ;;
      --vmid)
        need_value "$@"
        VMID=$2
        shift 2
        ;;
      --host)
        need_value "$@"
        SSH_HOST=$2
        shift 2
        ;;
      --ip)
        need_value "$@"
        IP=$2
        shift 2
        ;;
      --template)
        need_value "$@"
        TEMPLATE=$2
        shift 2
        ;;
      --dry-run)
        DRY_RUN=1
        shift
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        usage_error "unknown argument: $1"
        ;;
    esac
  done

  [[ -n $NODE ]] || usage_error "--node is required"
  [[ -n $VMID ]] || usage_error "--vmid is required"
  SSH_HOST=${SSH_HOST:-$NODE}

  [[ $NODE =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$ ]] || usage_error "invalid --node: $NODE"
  [[ $VMID =~ ^[1-9][0-9]{2,8}$ ]] || usage_error "invalid --vmid: $VMID"
  [[ $SSH_HOST =~ ^[A-Za-z0-9_][A-Za-z0-9_.@:-]*$ ]] || usage_error "invalid --host: $SSH_HOST"
  [[ $IP == dhcp || $IP =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$ ]] || usage_error "invalid --ip: $IP"
  [[ -z $TEMPLATE || $TEMPLATE =~ ^[A-Za-z0-9][A-Za-z0-9._-]*\.tar\.(gz|xz|zst)$ ]] || usage_error "invalid --template: $TEMPLATE"
}

# Quotes words so that a POSIX shell parses them back into the same words.
shell_join() {
  local word joined="" escaped_quote="'\\''"
  for word in "$@"; do
    if [[ ! $word =~ ^[A-Za-z0-9_@%+=:,./-]+$ ]]; then
      word="'${word//\'/$escaped_quote}'"
    fi
    joined+=" $word"
  done
  printf '%s' "${joined# }"
}

# Plan and progress lines use fd 3, so capturing a command's output with $(...)
# cannot swallow them.
plan() {
  printf '%s\n' "$*" >&3
}

step() {
  STEP=$((STEP + 1))
  plan "# Step $STEP: $*"
}

ssh_node() {
  "${SSH_CMD[@]}" "$SSH_HOST" "$1"
}

on_node() {
  local remote
  remote=$(shell_join "$@")
  if ((DRY_RUN)); then
    plan "[$SSH_HOST] $remote"
    return 0
  fi
  ssh_node "$remote" </dev/null
}

on_node_with_file() {
  local file=$1 remote
  shift
  remote=$(shell_join "$@")
  if ((DRY_RUN)); then
    plan "[$SSH_HOST] $remote < $file"
    return 0
  fi
  ssh_node "$remote" <"$file"
}

run_local() {
  if ((DRY_RUN)); then
    plan "[local] $(shell_join "$@")"
    return 0
  fi
  "$@"
}

in_lxc() {
  on_node pct exec "$VMID" -- "$@"
}

as_runner() {
  in_lxc runuser -l runner -c "$1"
}

apt_in_lxc() {
  in_lxc env DEBIAN_FRONTEND=noninteractive "$@"
}

load_node_ips() {
  [[ -r $NFT_CONF ]] || die "cannot read $NFT_CONF"
  local list
  list=$(sed -n 's/^define PVE_NODES = { \(.*\) }$/\1/p' "$NFT_CONF")
  IFS=', ' read -r -a NODE_IPS <<<"$list"
  ((${#NODE_IPS[@]} > 0)) || die "no PVE_NODES in $NFT_CONF"
}

check_target() {
  step "Check the GitHub rights, the node and the VMID"
  local admin actual

  admin=$(run_local gh api "repos/$REPO" --jq .permissions.admin)
  ((DRY_RUN)) || [[ $admin == true ]] || die "gh needs admin rights on $REPO to register the runner"

  # pct create always places the LXC on the node it runs on.
  actual=$(on_node hostname -s)
  ((DRY_RUN)) || [[ $actual == "$NODE" ]] || die "$SSH_HOST is $actual, not $NODE"

  on_node pvesh get /cluster/nextid --vmid "$VMID" >/dev/null ||
    die "VMID $VMID is not free: a guest, or a config left on a dead node, holds it. Pick another VMID"
}

newest_template() {
  awk -v prefix="$TEMPLATE_PREFIX" 'index($2, prefix) == 1 && $2 ~ /_amd64[.]tar/ { print $2 }' |
    sort -V | tail -n 1
}

fetch_template() {
  step "Fetch the LXC template"
  on_node pveam update
  if [[ -z $TEMPLATE ]]; then
    TEMPLATE=$(on_node pveam available --section system | newest_template)
    if ((DRY_RUN)); then
      TEMPLATE="<newest ${TEMPLATE_PREFIX}* amd64 template>"
    fi
    [[ -n $TEMPLATE ]] || die "no ${TEMPLATE_PREFIX}* amd64 template is available"
  fi
  on_node pveam download "$TEMPLATE_STORAGE" "$TEMPLATE"
}

wait_for_network() {
  local attempt
  for ((attempt = 1; attempt <= RETRIES; attempt++)); do
    if in_lxc getent hosts deb.debian.org >/dev/null; then
      return 0
    fi
    sleep "$RETRY_DELAY"
  done
  die "LXC $VMID has no working DNS"
}

create_lxc() {
  step "Create and start unprivileged LXC $VMID on $NODE"
  local net="name=eth0,bridge=$BRIDGE,ip=$IP"
  [[ $IP == dhcp ]] || net+=",gw=$LAN_GATEWAY"

  on_node pct create "$VMID" "$TEMPLATE_STORAGE:vztmpl/$TEMPLATE" \
    --hostname "$RUNNER_NAME" \
    --unprivileged 1 \
    --features nesting=1 \
    --onboot 1 \
    --cores "$CORES" \
    --memory "$MEMORY_MB" \
    --rootfs "$ROOTFS_STORAGE:$DISK_GB" \
    --net0 "$net" \
    --nameserver "$NAMESERVER"
  LXC_CREATED=1
  on_node pct start "$VMID"
  wait_for_network
}

install_packages() {
  step "Install packages and the runner account"
  apt_in_lxc apt-get update
  apt_in_lxc apt-get install -y --no-install-recommends ca-certificates curl git nftables unattended-upgrades

  # The sudo package refuses removal while root has no password, unless forced.
  apt_in_lxc SUDO_FORCE_REMOVE=yes apt-get purge -y sudo openssh-server

  # The firewall allows 443 but not 80, so apt must leave plain HTTP.
  in_lxc find /etc/apt -maxdepth 2 -type f '(' -name sources.list -o -name '*.list' -o -name '*.sources' ')' \
    -exec sed -i 's#http://#https://#' '{}' +
  apt_in_lxc apt-get update --error-on=any
  in_lxc sh -c "printf '%s\n' 'APT::Periodic::Update-Package-Lists \"1\";' 'APT::Periodic::Unattended-Upgrade \"1\";' > /etc/apt/apt.conf.d/20auto-upgrades"

  in_lxc useradd --create-home --shell /bin/bash runner
  in_lxc passwd --lock root
}

install_runner() {
  step "Install runner $RUNNER_VERSION, checked against its pinned SHA-256"
  as_runner "mkdir -p $RUNNER_DIR && cd $RUNNER_DIR && curl -fsSL -o $RUNNER_TARBALL $RUNNER_URL && printf '%s  %s\n' $RUNNER_SHA256 $RUNNER_TARBALL | sha256sum --check --strict - && tar xzf $RUNNER_TARBALL && rm $RUNNER_TARBALL"
  apt_in_lxc "$RUNNER_DIR/bin/installdependencies.sh"
}

apply_firewall() {
  step "Apply the nftables policy"
  # cat reads the open stdin. Tools that reopen /dev/stdin can be refused here,
  # because the host-side pipe belongs to a uid the LXC does not map.
  on_node_with_file "$NFT_CONF" pct exec "$VMID" -- sh -c 'cat > /etc/nftables.conf'
  in_lxc nft -c -f /etc/nftables.conf
  in_lxc systemctl enable --now nftables
  in_lxc nft list table inet runner
}

assert_open() {
  in_lxc runuser -u runner -- timeout 5 bash -c "exec 3<>/dev/tcp/$1/$2" ||
    die "$1:$2 must be reachable from the LXC"
}

# The negation runs inside the LXC, so a failed ssh or pct cannot pass as blocked.
assert_blocked() {
  in_lxc runuser -u runner -- bash -c "! timeout 5 bash -c 'exec 3<>/dev/tcp/$1/$2' 2>/dev/null" ||
    die "$1:$2 must be blocked from the LXC"
}

check_posture() {
  step "Check the LXC before it can take jobs"
  local config ip

  config=$(on_node pct config "$VMID")
  ((DRY_RUN)) || [[ $config == *"unprivileged: 1"* ]] || die "LXC $VMID is not unprivileged"

  in_lxc systemctl is-enabled nftables
  in_lxc runuser -u runner -- bash -c '! sudo -n true 2>/dev/null' ||
    die "the runner account can use sudo"
  in_lxc runuser -u runner -- bash -c '! /usr/sbin/nft list ruleset 2>/dev/null' ||
    die "the runner account can read the firewall"

  for ip in "${NODE_IPS[@]}"; do
    assert_blocked "$ip" 22
    assert_open "$ip" 8006
  done
  assert_open github.com 443
  apt_in_lxc apt-get update --error-on=any || die "apt cannot reach its mirrors through the firewall"
}

wait_for_idle() {
  local attempt state=""
  for ((attempt = 1; attempt <= RETRIES; attempt++)); do
    state=$(run_local gh api "repos/$REPO/actions/runners" \
      --jq ".runners[] | select(.name == \"$RUNNER_NAME\") | \"\\(.status) \\(.busy)\"") || state=""
    if ((DRY_RUN)) || [[ $state == "online false" ]]; then
      return 0
    fi
    sleep "$RETRY_DELAY"
  done
  die "runner $RUNNER_NAME is not online and idle; last state: ${state:-not listed}"
}

register_runner() {
  step "Register the runner and start its service"
  local token_cmd=(gh api -X POST "repos/$REPO/actions/runners/registration-token" --jq .token)
  local configure remote

  # The short-lived token crosses a pipe into the runner's environment, which
  # config.sh reads as ACTIONS_RUNNER_INPUT_TOKEN. It is never stored and never
  # reaches a command line.
  configure="IFS= read -r ACTIONS_RUNNER_INPUT_TOKEN && export ACTIONS_RUNNER_INPUT_TOKEN && cd $RUNNER_DIR && exec ./config.sh --unattended --replace --url https://github.com/$REPO --name $RUNNER_NAME --labels $RUNNER_LABEL"
  remote=$(shell_join pct exec "$VMID" -- runuser -l runner -c "$configure")

  if ((DRY_RUN)); then
    plan "[local] $(shell_join "${token_cmd[@]}") | [$SSH_HOST] $remote"
  else
    "${token_cmd[@]}" | ssh_node "$remote"
  fi

  in_lxc sh -c "cd $RUNNER_DIR && ./svc.sh install runner && ./svc.sh start"
  wait_for_idle
}

finish() {
  local next="infra/runner/issue-token.sh --node $NODE --vmid $VMID"
  [[ $SSH_HOST == "$NODE" ]] || next+=" --host $SSH_HOST"

  if ((DRY_RUN)); then
    plan "# Next: $next"
    return 0
  fi
  printf 'Runner %s is online and idle in LXC %s on %s. Took %ss.\n' "$RUNNER_NAME" "$VMID" "$NODE" "$SECONDS"
  printf 'Next: %s\n' "$next"
}

# Runs from the EXIT trap.
# shellcheck disable=SC2317,SC2329
report_failure() {
  local status=$?
  if ((status != 0 && LXC_CREATED)); then
    printf 'LXC %s stays on %s for inspection. To start over, run there: pct stop %s; pct destroy %s\n' \
      "$VMID" "$NODE" "$VMID" "$VMID" >&2
  fi
}

main() {
  parse_args "$@"
  exec 3>&1
  trap report_failure EXIT

  load_node_ips
  if ((DRY_RUN)); then
    plan "# Dry run: these commands are printed, not executed."
    plan "# [$SSH_HOST] lines run on the node through: ${SSH_CMD[*]} $SSH_HOST <command>"
  fi

  check_target
  fetch_template
  create_lxc
  install_packages
  install_runner
  apply_firewall
  check_posture
  register_runner
  finish
}

main "$@"
