#!/usr/bin/env bash
# Writes docker-compose.yaml, .env and, for HTTPS with Caddy, a Caddyfile into the
# install directory, then starts the containers. Running it again in the same
# directory keeps the database password, so the existing database stays readable.
# The release workflow replaces __VERSION__ with the released version.

if [ -z "${BASH_VERSION:-}" ]; then
  echo "This installer needs bash (on Alpine: apk add bash). Run it with: bash install.sh" >&2
  exit 1
fi

set -euo pipefail

SPEICHER_VERSION="__VERSION__"
IMAGE="ghcr.io/copetence/speicher.md"
DOCS_URL="https://docs.speicher.md/speicher-md"
READY_TIMEOUT=180

DIR=""
MODE=""
DOMAIN=""
CADDY=""
ACME_EMAIL=""
PORT=""
IMAGE_TAG=""
START=""
ASSUME_YES=false
OVERWRITE=false

# Set while running
KEEP_FILES=false
NEW_PASSWORD=false
CLAIMED=false
HAS_ADMIN=false
TUNNEL_SHOWN=false

# ---------------------------------------------------------------------------
# Terminal settings

# Not tput cols: inside $(…) it can't see the terminal and reports 80
term_width() {
  local size
  size=$(stty size 2>/dev/null </dev/tty) || size=""
  size=${size#* }
  if [ "${size:-0}" -gt 0 ] 2>/dev/null; then echo "$size"; else echo "${COLUMNS:-80}"; fi
}

# rows_for <printed text>
rows_for() {
  local plain width
  plain=$(printf '%s' "$1" | sed $'s/\033\\[[0-9;?]*[A-Za-z]//g')
  width=$(term_width)
  echo $(((${#plain} + width - 1) / width))
}

color_depth() {
  local colors
  case "${TERM:-dumb}" in dumb | unknown) echo none && return ;; esac
  colors=$(tput colors 2>/dev/null) || colors=""
  if [ -z "$colors" ]; then
    # No terminfo entry, e.g. xterm-ghostty over SSH
    case "$TERM" in
      *256color*) colors=256 ;;
      xterm* | screen* | tmux* | rxvt* | vt220 | linux | ansi | *color*) colors=8 ;;
      *) colors=0 ;;
    esac
  fi
  if [ "$colors" -ge 256 ] 2>/dev/null; then
    echo 256
  elif [ "$colors" -ge 8 ] 2>/dev/null; then
    echo 8
  else
    echo none
  fi
}

supports_unicode() {
  # Linux console font lacks the glyphs
  [ "${TERM:-}" != linux ] || return 1
  case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
    *[Uu][Tt][Ff]-8* | *[Uu][Tt][Ff]8*) return 0 ;;
  esac
  return 1
}

CURSOR_UI=false
if [ -t 1 ]; then
  case "${TERM:-dumb}" in dumb | unknown) ;; *) CURSOR_UI=true ;; esac
fi

BOLD="" RED="" GREEN="" YELLOW="" RESET="" ACCENT="" MUTED=""
BANNER_COLORS=("" "" "" "" "" "")
DEPTH=none
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then DEPTH=$(color_depth); fi
case "$DEPTH" in
  256)
    ACCENT=$'\033[38;5;32m'
    MUTED=$'\033[38;5;245m'
    BANNER_COLORS=(
      $'\033[38;5;62m' $'\033[38;5;68m' $'\033[38;5;32m'
      $'\033[38;5;31m' $'\033[38;5;37m' $'\033[38;5;36m'
    )
    ;;
  8)
    ACCENT=$'\033[36m'
    MUTED=$'\033[2m'
    BANNER_COLORS=("$ACCENT" "$ACCENT" "$ACCENT" "$ACCENT" "$ACCENT" "$ACCENT")
    ;;
esac
if [ -n "$ACCENT" ]; then
  BOLD=$'\033[1m' RED=$'\033[31m' GREEN=$'\033[32m' YELLOW=$'\033[33m' RESET=$'\033[0m'
fi

UNICODE=false
if supports_unicode; then
  UNICODE=true
  G_STEP="◆" G_OK="✓" G_WARN="▲" G_ERROR="✗" G_DONE="◇" G_PROMPT="›" G_POINTER="❯" G_SEP="·" G_KEYS="↑/↓"
  SPINNER=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏)
else
  G_STEP="==>" G_OK="+" G_WARN="!" G_ERROR="x" G_DONE="-" G_PROMPT=">" G_POINTER=">" G_SEP="-" G_KEYS="Up/Down"
  SPINNER=('|' '/' '-' '\')
fi

# ---------------------------------------------------------------------------
# Output

info() {
  if [ -z "$*" ]; then printf '\n'; else printf '  %s\n' "$*"; fi
}
step() { printf '\n%s%s%s %s%s%s\n' "$ACCENT" "$G_STEP" "$RESET" "$BOLD" "$*" "$RESET"; }
ok() { printf '  %s%s%s %s\n' "$GREEN" "$G_OK" "$RESET" "$*"; }
warn() {
  local line
  printf '  %s%s%s %s\n' "$YELLOW" "$G_WARN" "$RESET" "$1" >&2
  shift
  for line in "$@"; do printf '    %s\n' "$line" >&2; done
}
die() {
  printf '\n  %s%s error:%s %s\n' "$RED$BOLD" "$G_ERROR" "$RESET" "$*" >&2
  exit 1
}
cmd() { printf '    %s%s%s\n' "$ACCENT" "$*" "$RESET"; }
link() { printf '%s%s%s' "$ACCENT$BOLD" "$1" "$RESET"; }

banner() {
  if ! $UNICODE || [ "$(term_width)" -lt 72 ]; then
    printf '\n  %s%sSpeicher.md%s\n' "$BOLD" "$ACCENT" "$RESET"
    return
  fi
  local i=0 line
  local lines=(
    '███████╗██████╗ ███████╗██╗ ██████╗██╗  ██╗███████╗██████╗'
    '██╔════╝██╔══██╗██╔════╝██║██╔════╝██║  ██║██╔════╝██╔══██╗'
    '███████╗██████╔╝█████╗  ██║██║     ███████║█████╗  ██████╔╝         ╻'
    '╚════██║██╔═══╝ ██╔══╝  ██║██║     ██╔══██║██╔══╝  ██╔══██╗   ┏┳┓ ┏━┫'
    '███████║██║     ███████╗██║╚██████╗██║  ██║███████╗██║  ██║ ▪ ╹╹╹ ┗━┛'
    '╚══════╝╚═╝     ╚══════╝╚═╝ ╚═════╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝'
  )
  printf '\n'
  for line in "${lines[@]}"; do
    printf '  %s%s%s\n' "${BANNER_COLORS[i]}" "$line" "$RESET"
    i=$((i + 1))
  done
}

usage() {
  cat <<EOF
Sets up a Speicher instance with Docker Compose.

Usage: bash install.sh [flags]

Without flags, the script asks for everything it needs. With --yes, it asks
nothing and uses the flags and defaults.

  --dir <path>          install directory (default: ./speicher)
  --mode <mode>         local   reachable on this machine only, over http://localhost
                        public  reachable on a domain, over HTTPS
  --domain <domain>     domain for public mode, e.g. docs.example.com
  --caddy, --no-caddy   in public mode, let Caddy get HTTPS certificates (default),
                        or bring your own reverse proxy
  --acme-email <email>  email for Let's Encrypt notices (optional, with Caddy)
  --port <port>         port on the host (default: 3000; not used with Caddy)
  --image-tag <tag>     image tag of ${IMAGE} (default: $(default_image_tag))
  --no-start            write the files, but do not start the containers
  --overwrite           replace existing files in the install directory, after
                        backing them up
  -y, --yes             ask no questions
  -h, --help            show this help

Set NO_COLOR=1 for output without colors.
EOF
}

# ---------------------------------------------------------------------------
# Prompts

has_tty() { { : </dev/tty; } 2>/dev/null; }

# prompt <question> [hint], sets PROMPT_TEXT to the printed prompt
prompt() {
  local hint=${2:+ ($2)}
  printf -v PROMPT_TEXT '  %s?%s %s%s%s %s%s ' "$ACCENT" "$RESET" "$1" "$MUTED" "$hint" "$G_PROMPT" "$RESET"
  printf '%s' "$PROMPT_TEXT"
}

# answered <question> <answer> <rows to replace>
answered() {
  $CURSOR_UI || return 0
  printf '\033[%dA\033[J' "$3"
  printf '  %s%s%s %s %s%s%s\n' "$MUTED" "$G_DONE" "$RESET" "$1" "$ACCENT" "$2" "$RESET"
}

# ask <variable> <question> [default]
ask() {
  local __var=$1 question=$2 default=${3:-} answer="" rows
  if $ASSUME_YES; then
    printf -v "$__var" '%s' "$default"
    return
  fi
  prompt "$question" "$default"
  IFS= read -r answer </dev/tty || true
  rows=$(rows_for "$PROMPT_TEXT$answer")
  answer=${answer:-$default}
  answered "$question" "${answer:-skipped}" "$rows"
  printf -v "$__var" '%s' "$answer"
}

# ask_yes_no <question> <y|n>
ask_yes_no() {
  local question=$1 default=$2 hint answer rows
  if $ASSUME_YES; then
    [ "$default" = y ]
    return
  fi
  if [ "$default" = y ]; then hint="Y/n"; else hint="y/N"; fi
  while true; do
    prompt "$question" "$hint"
    IFS= read -r answer </dev/tty || true
    rows=$(rows_for "$PROMPT_TEXT$answer")
    case "${answer:-$default}" in
      [Yy] | [Yy][Ee][Ss])
        answered "$question" Yes "$rows"
        return 0
        ;;
      [Nn] | [Nn][Oo])
        answered "$question" No "$rows"
        return 1
        ;;
      *) info "Please answer y or n." ;;
    esac
  done
}

# choose <variable> <question> <default number> <option>…, sets the chosen option's number
choose() {
  local __var=$1 question=$2 default=$3
  shift 3
  if $ASSUME_YES; then
    printf -v "$__var" '%s' "$default"
    return
  fi
  if $CURSOR_UI; then
    choose_with_arrows "$__var" "$question" "$default" "$@"
  else
    choose_by_number "$__var" "$question" "$default" "$@"
  fi
}

# menu_option <option> [selected]
menu_option() {
  if [ -n "${2:-}" ]; then
    printf '    %s%s %s%s' "$ACCENT$BOLD" "$G_POINTER" "$1" "$RESET"
  else
    printf '      %s' "$1"
  fi
}

choose_with_arrows() {
  local __var=$1 question=$2 current=$3 option key rest i title hint line option_rows=0
  shift 3
  local count=$#
  printf -v title '  %s?%s %s' "$ACCENT" "$RESET" "$question"
  printf -v hint '    %s%s to move, Enter to select%s' "$MUTED" "$G_KEYS" "$RESET"

  for option in "$@"; do option_rows=$((option_rows + $(rows_for "$(menu_option "$option")"))); done

  printf '%s\n%s\n' "$title" "$hint"
  printf '\033[?25l'
  while true; do
    i=1
    for option in "$@"; do
      if [ "$i" -eq "$current" ]; then
        line=$(menu_option "$option" selected)
      else
        line=$(menu_option "$option")
      fi
      printf '\033[2K%s\n' "$line"
      i=$((i + 1))
    done

    IFS= read -rsn1 key </dev/tty || key=""
    case "$key" in
      "") break ;;
      $'\033')
        # Lone Esc times out
        IFS= read -rsn2 -t 1 rest </dev/tty || rest=""
        case "$rest" in
          "[A" | "OA") key=k ;;
          "[B" | "OB") key=j ;;
        esac
        ;;
    esac
    case "$key" in
      k) current=$(((current + count - 2) % count + 1)) ;;
      j) current=$((current % count + 1)) ;;
      [1-9]) [ "$key" -gt "$count" ] || current=$key ;;
    esac
    printf '\033[%dA' "$option_rows"
  done
  printf '\033[?25h'
  answered "$question" "${!current}" \
    $(($(rows_for "$title") + $(rows_for "$hint") + option_rows))
  printf -v "$__var" '%s' "$current"
}

choose_by_number() {
  local __var=$1 question=$2 default=$3 option i answer
  shift 3
  printf '  %s?%s %s\n' "$ACCENT" "$RESET" "$question"
  i=1
  for option in "$@"; do
    info "  $i) $option"
    i=$((i + 1))
  done
  while true; do
    prompt "Choose" "$default"
    IFS= read -r answer </dev/tty || true
    answer=${answer:-$default}
    if [[ "$answer" =~ ^[0-9]+$ ]] && [ "$answer" -ge 1 ] && [ "$answer" -le $# ]; then
      printf -v "$__var" '%s' "$answer"
      return
    fi
    info "Please enter a number from 1 to $#."
  done
}

# ---------------------------------------------------------------------------
# Checks

default_image_tag() {
  if [ "$SPEICHER_VERSION" = "__VERSION__" ]; then echo latest; else echo "$SPEICHER_VERSION"; fi
}

valid_domain() {
  [[ "$1" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$ ]]
}

valid_port() {
  [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

# Succeeds when something on this host listens on the TCP port
# Not lsof: BusyBox's ignores its arguments and always succeeds
port_in_use() {
  if command -v ss >/dev/null 2>&1; then
    ss -Hltn "sport = :$1" 2>/dev/null | grep -q .
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
  fi
}

check_docker() {
  command -v docker >/dev/null 2>&1 ||
    die "Docker is not installed. Install it first: https://docs.docker.com/engine/install/"
  docker compose version >/dev/null 2>&1 ||
    die "The Docker Compose plugin is missing. Install it first: https://docs.docker.com/compose/install/"
  docker info >/dev/null 2>&1 ||
    die "Cannot reach the Docker daemon. Start Docker, or run the script as a user who may use Docker."
  ok "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null) with Compose version $(docker compose version --short 2>/dev/null)"
}

# Runs before anything is asked or written, so a missing tool stops the script early
check_dependencies() {
  step "Checking dependencies"
  local tool missing=""
  for tool in basename cat chmod cp date grep head id mkdir mktemp mv sed sleep tail tr uname; do
    command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
  done
  command -v openssl >/dev/null 2>&1 || command -v od >/dev/null 2>&1 || missing="$missing openssl"
  [ -z "$missing" ] || die "These required tools are missing:$missing. Install them with your package manager."
  command -v ss >/dev/null 2>&1 ||
    warn "ss is not installed, so the port check only sees services on 127.0.0.1." \
      "For a full check, install iproute2 (on Alpine: apk add iproute2)."

  if [ "$START" = no ]; then
    if ! { command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; }; then
      warn "Docker with Compose is not available. The files will be written, but not checked."
    fi
  else
    check_docker
  fi
}

check_start() {
  step "Checking the host"

  local port
  for port in $(published_ports); do
    if port_in_use "$port" && ! docker compose --project-directory "$DIR" ps -q 2>/dev/null | grep -q .; then
      warn "Port $port is already in use. The containers will not start until it is free."
    fi
  done

  if [ "$MODE" = public ] && [ "$CADDY" = yes ]; then
    if command -v getent >/dev/null 2>&1; then
      getent hosts "$DOMAIN" >/dev/null 2>&1 ||
        warn "$DOMAIN does not resolve yet. Caddy gets a certificate once it points at this server."
    elif command -v host >/dev/null 2>&1; then
      host "$DOMAIN" >/dev/null 2>&1 ||
        warn "$DOMAIN does not resolve yet. Caddy gets a certificate once it points at this server."
    fi
  fi
  ok "Ready to start"
}

published_ports() {
  if [ "$MODE" = public ] && [ "$CADDY" = yes ]; then echo "80 443"; else echo "$PORT"; fi
}

# ---------------------------------------------------------------------------
# Questions

parse_flags() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dir | --mode | --domain | --acme-email | --port | --image-tag)
        [ $# -ge 2 ] || die "$1 needs a value"
        case "$1" in
          --dir) DIR=$2 ;;
          --mode) MODE=$2 ;;
          --domain) DOMAIN=$2 ;;
          --acme-email) ACME_EMAIL=$2 ;;
          --port) PORT=$2 ;;
          --image-tag) IMAGE_TAG=$2 ;;
        esac
        shift 2
        ;;
      --caddy) CADDY=yes && shift ;;
      --no-caddy) CADDY=no && shift ;;
      --no-start) START=no && shift ;;
      --overwrite) OVERWRITE=true && shift ;;
      -y | --yes) ASSUME_YES=true && shift ;;
      -h | --help) usage && exit 0 ;;
      *) die "unknown flag: $1 (see --help)" ;;
    esac
  done

  case "$MODE" in
    "" | local | public) ;;
    *) die "--mode is local or public, not $MODE" ;;
  esac
  [ -z "$PORT" ] || valid_port "$PORT" || die "--port must be a number from 1 to 65535"
  [ -z "$DOMAIN" ] || valid_domain "$DOMAIN" || die "--domain must be a domain like docs.example.com, without http:// or a path"
  if $ASSUME_YES && [ "$MODE" = public ] && [ -z "$DOMAIN" ]; then die "--mode public needs --domain"; fi
  if ! $ASSUME_YES && ! has_tty; then die "no terminal to ask questions on; run with --yes and flags (see --help)"; fi
}

ask_directory() {
  step "Install directory"
  [ -n "$DIR" ] || ask DIR "Where should Speicher be installed?" "./speicher"
  [ -n "$DIR" ] || die "the install directory must not be empty"
  mkdir -p "$DIR"
  DIR=$(cd "$DIR" && pwd)

  if [ -f "$DIR/docker-compose.yaml" ]; then
    local choice
    if $OVERWRITE; then
      choice=1
    elif $ASSUME_YES; then
      die "$DIR already has a docker-compose.yaml; pass --overwrite to replace it"
    else
      info ""
      choose choice "$DIR already has a docker-compose.yaml. What should happen?" 3 \
        "Back it up and write a new one (the database password is kept)" \
        "Keep it and only start the containers" \
        "Abort"
    fi
    case "$choice" in
      1) ;;
      2) KEEP_FILES=true ;;
      *) exit 1 ;;
    esac
  fi
  ok "$DIR"
}

ask_mode() {
  step "Set domain"
  if [ -z "$MODE" ]; then
    local choice
    choose choice "How do you want to setup Speicher.md?" 1 \
      "Localhost (http://localhost)" \
      "Public domain over HTTPS"
    if [ "$choice" = 1 ]; then MODE=local; else MODE=public; fi
  fi

  if [ "$MODE" = public ]; then
    while [ -z "$DOMAIN" ]; do
      ask DOMAIN "Domain for Speicher, e.g. docs.example.com"
      DOMAIN=${DOMAIN#http://}
      DOMAIN=${DOMAIN#https://}
      DOMAIN=${DOMAIN%/}
      if ! valid_domain "$DOMAIN"; then
        warn "\"$DOMAIN\" is not a domain. Write it without http:// and without a path."
        DOMAIN=""
      fi
    done

    if [ -z "$CADDY" ]; then
      info ""
      info "${MUTED}Caddy can run alongside Speicher.md and get HTTPS certificates from Let's Encrypt.${RESET}"
      info "${MUTED}It needs ports 80 and 443. Skip it if you already run a reverse proxy, e.g. nginx.${RESET}"
      if ask_yes_no "Set up Caddy for HTTPS?" y; then CADDY=yes; else CADDY=no; fi
    fi
    if [ "$CADDY" = yes ] && [ -z "$ACME_EMAIL" ]; then
      ask ACME_EMAIL "Email for Let's Encrypt notices, optional"
    fi
  else
    CADDY=no
  fi

  if [ "$CADDY" = no ] && [ -z "$PORT" ]; then
    local suggestion=3000
    if ! $ASSUME_YES; then
      while port_in_use "$suggestion" && [ "$suggestion" -lt 3100 ]; do suggestion=$((suggestion + 1)); done
      [ "$suggestion" = 3000 ] || info "${MUTED}Port 3000 is in use; $suggestion is free.${RESET}"
    fi
    while true; do
      ask PORT "Port on this machine" "$suggestion"
      valid_port "$PORT" && break
      warn "The port must be a number from 1 to 65535."
      PORT=""
    done
  fi
  [ -n "$IMAGE_TAG" ] || IMAGE_TAG=$(default_image_tag)
}

# Takes the choices from the files of an earlier install, for the checks and the summary
read_existing() {
  local ignored=""
  [ -z "$MODE" ] || ignored="$ignored --mode"
  [ -z "$DOMAIN" ] || ignored="$ignored --domain"
  [ -z "$PORT" ] || ignored="$ignored --port"
  [ -z "$IMAGE_TAG" ] || ignored="$ignored --image-tag"
  [ -z "$CADDY" ] || ignored="$ignored --caddy/--no-caddy"
  [ -z "$ACME_EMAIL" ] || ignored="$ignored --acme-email"
  [ -z "$ignored" ] || warn "The existing files are kept, so these flags have no effect:$ignored" \
    "Choose to write a new docker-compose.yaml to apply them."

  [ -n "$(env_get POSTGRES_PASSWORD)" ] || die "$DIR/.env has no POSTGRES_PASSWORD"
  IMAGE_TAG=$(env_get SPEICHER_IMAGE_TAG)
  IMAGE_TAG=${IMAGE_TAG:-$(default_image_tag)}
  MODE=local
  CADDY=no
  case "$(env_get SPEICHER_PUBLIC_URL)" in
    https://*)
      MODE=public
      DOMAIN=$(env_get SPEICHER_PUBLIC_URL)
      DOMAIN=${DOMAIN#https://}
      ;;
  esac
  if grep -q '^  caddy:' "$DIR/docker-compose.yaml"; then CADDY=yes; fi
  PORT=$(sed -n "s/^ *- '\(127\.0\.0\.1:\)\{0,1\}\([0-9]*\):3000'$/\2/p" "$DIR/docker-compose.yaml" | head -n 1)
  PORT=${PORT:-3000}
}

public_url() {
  if [ "$MODE" = public ]; then
    echo "https://$DOMAIN"
  else
    echo "http://localhost:$PORT"
  fi
}

summary_row() { printf '  %s%-10s%s %s\n' "$MUTED" "$1" "$RESET" "$2"; }

confirm() {
  step "Summary"
  summary_row Directory "$DIR"
  summary_row URL "$(link "$(public_url)")"
  if [ "$MODE" = public ]; then
    if [ "$CADDY" = yes ]; then
      summary_row HTTPS "Caddy, with a certificate from Let's Encrypt"
    else
      summary_row HTTPS "your own reverse proxy, forwarding to 127.0.0.1:$PORT"
    fi
  fi
  summary_row Image "$IMAGE:$IMAGE_TAG"
  if $KEEP_FILES; then
    summary_row Files "kept as they are"
  else
    summary_row Files "docker-compose.yaml, .env$([ "$CADDY" = yes ] && echo ", Caddyfile")"
  fi
  info ""
  ask_yes_no "Continue?" y || exit 1

  if [ -z "$START" ]; then
    if ask_yes_no "Start the containers when the files are written?" y; then START=yes; else START=no; fi
  fi
}

# ---------------------------------------------------------------------------
# Files

# Writes stdin to a file through a temporary file, so it is never half-written
write_file() {
  local target=$1 mode=${2:-644} tmp
  tmp=$(mktemp "$target.XXXXXX")
  if cat >"$tmp" && chmod "$mode" "$tmp" && mv "$tmp" "$target"; then return; fi
  rm -f "$tmp"
  die "could not write $target"
}

backup() {
  if [ -f "$1" ]; then
    local stamp
    stamp=$(date +%Y%m%d-%H%M%S)
    cp -p "$1" "$1.bak-$stamp"
    info "${MUTED}Backed up $(basename "$1") to $(basename "$1").bak-$stamp${RESET}"
  fi
}

new_password() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

# The value of KEY in .env, empty if it is not there
env_get() {
  [ -f "$DIR/.env" ] || return 0
  sed -n "s/^$1=//p" "$DIR/.env" | tail -n 1
}

# Sets KEY=value in .env, keeping every other line, such as secrets added by hand
env_set() {
  local key=$1 value=$2
  {
    if [ -f "$DIR/.env" ]; then grep -v "^$key=" "$DIR/.env" || true; fi
    printf '%s=%s\n' "$key" "$value"
  } | write_file "$DIR/.env" 600
}

write_env() {
  local password
  password=$(env_get POSTGRES_PASSWORD)
  if [ -z "$password" ]; then
    password=$(new_password)
    NEW_PASSWORD=true
  fi
  backup "$DIR/.env"
  env_set POSTGRES_PASSWORD "$password"
  env_set SPEICHER_PUBLIC_URL "$(public_url)"
  env_set SPEICHER_IMAGE_TAG "$IMAGE_TAG"
  if $NEW_PASSWORD; then ok ".env, with a new database password"; else ok ".env, keeping the database password"; fi
}

render_compose() {
  cat <<EOF
# The values in \${…} come from the .env file next to this one.

x-speicher: &speicher
  image: $IMAGE:\${SPEICHER_IMAGE_TAG}
  environment:
    SPEICHER_DATABASE_URL: postgres://speicher:\${POSTGRES_PASSWORD}@db:5432/speicher
    SPEICHER_PUBLIC_URL: \${SPEICHER_PUBLIC_URL}
EOF
  if [ "$MODE" = public ]; then
    cat <<EOF
    # Trusts X-Forwarded-* headers from private addresses, where the proxy connects from
    SPEICHER_TRUST_PROXY: uniquelocal
EOF
  fi
  cat <<EOF
  volumes:
    - speicher-data:/var/lib/speicher
  restart: unless-stopped

services:
  db:
    image: pgvector/pgvector:pg17
    environment:
      POSTGRES_USER: speicher
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_DB: speicher
    volumes:
      - speicher-db:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U speicher -d speicher']
      interval: 2s
      timeout: 3s
      retries: 30
    restart: unless-stopped

  # Applies database migrations on every start, then exits. Web and worker wait for it.
  migrate:
    <<: *speicher
    command: ['speicher', 'migrate', 'up']
    restart: 'no'
    depends_on:
      db:
        condition: service_healthy

  web:
    <<: *speicher
EOF
  if [ "$CADDY" = no ]; then
    if [ "$MODE" = public ]; then
      cat <<EOF
    # Only the reverse proxy on this host may reach Speicher
    ports:
      - '127.0.0.1:$PORT:3000'
EOF
    else
      cat <<EOF
    ports:
      - '$PORT:3000'
EOF
    fi
  fi
  cat <<EOF
    depends_on:
      migrate:
        condition: service_completed_successfully

  worker:
    <<: *speicher
    command: ['node', 'dist/worker.js']
    depends_on:
      migrate:
        condition: service_completed_successfully
EOF
  if [ "$CADDY" = yes ]; then
    cat <<EOF

  # Serves HTTPS and gets the certificate from Let's Encrypt. Reads the Caddyfile.
  caddy:
    image: caddy:2
    ports:
      - '80:80'
      - '443:443'
      - '443:443/udp'
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    depends_on:
      - web
    restart: unless-stopped
EOF
  fi
  cat <<EOF

volumes:
  speicher-db:
  speicher-data:
EOF
  if [ "$CADDY" = yes ]; then
    cat <<EOF
  caddy-data:
  caddy-config:
EOF
  fi
}

render_caddyfile() {
  if [ -n "$ACME_EMAIL" ]; then
    printf '{\n\temail %s\n}\n\n' "$ACME_EMAIL"
  fi
  printf '%s {\n\treverse_proxy web:3000\n}\n' "$DOMAIN"
}

write_files() {
  step "Writing files"
  if $KEEP_FILES; then
    ok "Kept docker-compose.yaml and .env"
    return
  fi

  write_env
  backup "$DIR/docker-compose.yaml"
  render_compose | write_file "$DIR/docker-compose.yaml"
  ok "docker-compose.yaml"
  if [ "$CADDY" = yes ]; then
    backup "$DIR/Caddyfile"
    render_caddyfile | write_file "$DIR/Caddyfile"
    ok "Caddyfile"
  fi

  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    docker compose --project-directory "$DIR" config -q ||
      die "Docker Compose rejects the written docker-compose.yaml"
  fi
}

# ---------------------------------------------------------------------------
# Start

compose() { docker compose --project-directory "$DIR" "$@"; }

db_accepts_password() {
  compose exec -T -e PGPASSWORD="$(env_get POSTGRES_PASSWORD)" db \
    psql -h db -U speicher -d speicher -c 'select 1' >/dev/null 2>&1
}

# Postgres reads POSTGRES_PASSWORD only on volume creation.
# Connects via host "db": the local socket skips password auth.
ensure_database_password() {
  step "Checking the database"
  compose up -d --wait db
  if db_accepts_password; then
    ok "The database accepts the password in .env"
    return
  fi

  local volume
  volume=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' "$(compose ps -q db)")
  warn "The database was created with a different password than the one in .env." \
    "Restore the old .env to keep the data, or delete the database to start over."
  ask_yes_no "Delete the old database and start with an empty one?" n ||
    die "Not starting. Restore the old .env, or delete the database with: docker compose down && docker volume rm $volume"
  compose down --remove-orphans
  docker volume rm "$volume" >/dev/null
  compose up -d --wait db
  ok "Deleted the old database"
}

speicher_ready() {
  # Asks from inside the web container, so it works before DNS or the certificate is ready
  compose exec -T web node -e \
    "fetch('http://127.0.0.1:3000/-/readyz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))" \
    >/dev/null 2>&1
}

wait_until_ready() {
  step "Waiting for Speicher to be ready"
  local started=$SECONDS frame=0 elapsed=0
  if $CURSOR_UI; then printf '\033[?25l'; fi
  until speicher_ready; do
    elapsed=$((SECONDS - started))
    if [ "$elapsed" -ge "$READY_TIMEOUT" ]; then
      if $CURSOR_UI; then printf '\r\033[2K\033[?25h'; fi
      warn "Speicher is not ready after ${READY_TIMEOUT}s. The last log lines:"
      compose ps >&2 || true
      compose logs --tail 50 migrate web >&2 || true
      die "Speicher did not start. Fix the error above, then run: docker compose up -d"
    fi
    if $CURSOR_UI; then
      printf '\r\033[2K  %s%s%s Starting the containers %s%ss%s' \
        "$ACCENT" "${SPINNER[frame % ${#SPINNER[@]}]}" "$RESET" "$MUTED" "$elapsed" "$RESET"
      frame=$((frame + 1))
    fi
    sleep 1
  done
  if $CURSOR_UI; then printf '\r\033[2K\033[?25h'; fi
  ok "Speicher is ready after $((SECONDS - started))s"
}

start() {
  step "Pulling images"
  compose pull || warn "Pulling failed; starting with the images already on this machine."

  ensure_database_password

  step "Starting the containers"
  compose up -d

  wait_until_ready
}

# Opens the URL in the browser, when this machine has a desktop to open it on
open_browser() {
  if [ "$(uname -s)" = Darwin ] && command -v open >/dev/null 2>&1; then
    open "$1" >/dev/null 2>&1 || true
  elif [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$1" >/dev/null 2>&1 || true
  else
    return 1
  fi
}

# Succeeds while no administrator has signed in, so the instance can still be claimed.
# Asks about a code that cannot exist, which `speicher claim` answers by saying
# whether the instance is closed before it looks the code up.
claim_window_open() {
  local output
  output=$(compose exec -T -e SPEICHER_LOG_LEVEL=warn web speicher claim NONE-WAITING-0000 2>&1) || true
  case "$output" in
    *"already has an administrator"*) return 1 ;;
    *) return 0 ;;
  esac
}

tunnel_hint() {
  [ "$MODE" = local ] || return 0
  $TUNNEL_SHOWN && return 0
  TUNNEL_SHOWN=true
  info ""
  info "On a server without a browser, forward the port to your own computer by running"
  info "this there, and keep it open while you use Speicher:"
  info ""
  cmd "ssh -NL $PORT:localhost:$PORT $(id -un)@<server-ip>"
  info ""
  info "Then open $(link "$(public_url)") in your browser."
  info ""
}

# Also accepts the pasted command: docker compose exec web speicher claim <CODE>
claim_code() {
  local input=$1
  input=${input%"${input##*[![:space:]]}"}
  case "$input" in *"speicher claim"[[:space:]]*) input=${input##*[[:space:]]} ;; esac
  printf '%s' "${input#"${input%%[![:space:]]*}"}"
}

# Approves the browser the user opened, with the code its claim page shows
claim_instance() {
  local url code output
  url=$(public_url)
  if ! claim_window_open; then
    HAS_ADMIN=true
    return 0
  fi

  step "Claiming the instance"
  if open_browser "$url"; then
    info "Opened $(link "$url") in your browser."
  else
    info "Open $(link "$url") in your browser."
    tunnel_hint
  fi
  info "The claim page shows a code like QUIET-HERON-4471 to approve your session."
  info ""
  while true; do
    ask code "Code or command from the claim page, Enter to skip"
    code=$(claim_code "$code")
    [ -n "$code" ] || return 0
    if output=$(compose exec -T -e SPEICHER_LOG_LEVEL=warn web speicher claim "$code" 2>&1); then
      ok "$output"
      CLAIMED=true
      return 0
    fi
    warn "$output"
    case "$output" in
      *"already has an administrator"*)
        HAS_ADMIN=true
        return 0
        ;;
    esac
  done
}

next_steps() {
  local url
  url=$(public_url)
  step "Done"
  if ! $CLAIMED; then
    if $HAS_ADMIN; then
      info "Speicher runs at $(link "$url"). It already has an administrator, who can"
      info "sign in there."
    elif [ "$START" = yes ]; then
      info "Open $(link "$url") and claim the instance. The page shows a command"
      info "to run in $DIR, like:"
      info ""
      cmd "docker compose exec web speicher claim <CODE>"
      tunnel_hint
    else
      info "Start Speicher with:"
      info ""
      cmd "cd $DIR && docker compose up -d"
      info ""
      info "Then open $(link "$url") and claim the instance with a command like:"
      info ""
      cmd "docker compose exec web speicher claim <CODE>"
      tunnel_hint
    fi
    info ""
  fi
  if [ "$MODE" = public ]; then
    info "Point your reverse proxy at http://127.0.0.1:$PORT and serve $DOMAIN over HTTPS:"
    info "${MUTED}$DOCS_URL/05-operations/04-reverse-proxy-and-tls.md${RESET}"
    info ""
  fi
  info "Next: ${MUTED}$DOCS_URL/01-quick-start/02-setup-instance.md${RESET}"
  info ""
}

main() {
  parse_flags "$@"
  if $CURSOR_UI; then trap 'printf "\033[?25h"' EXIT; fi
  trap 'printf "\n"; exit 130' INT TERM

  banner
  info ""
  info "${MUTED}Installer ${G_SEP} $(default_image_tag) ${G_SEP} docs.speicher.md${RESET}"
  check_dependencies
  ask_directory
  if $KEEP_FILES; then read_existing; else ask_mode; fi
  confirm
  write_files
  if [ "$START" = yes ]; then
    check_start
    start
    # Someone has to read the code off the browser, so only when asking questions
    $ASSUME_YES || claim_instance
  fi
  next_steps
}

# Called on the last line, so a partly downloaded script does nothing
main "$@"
