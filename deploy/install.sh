#!/usr/bin/env bash
#
# Sets up a Speicher instance with Docker Compose
#
#   bash install.sh            asks what it needs to know
#   bash install.sh --help     lists the flags for a setup without questions
#
# Writes docker-compose.yaml, .env and, for HTTPS with Caddy, a Caddyfile into the
# install directory, then starts the containers. Running it again in the same
# directory keeps the database password, so the existing database stays readable.
#
# The release workflow replaces __VERSION__ with the released version, so a
# downloaded script installs the image it was released with.

set -euo pipefail

SPEICHER_VERSION="__VERSION__"
IMAGE="ghcr.io/copetence/speicher.md"
DOCS_URL="https://github.com/copetence/speicher.md/tree/main/documentation"
READY_TIMEOUT=180

# Answers, from flags or prompts
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

# ---------------------------------------------------------------------------
# Output

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD=$'\033[1m' DIM=$'\033[2m' RED=$'\033[31m' GREEN=$'\033[32m' YELLOW=$'\033[33m' RESET=$'\033[0m'
else
  BOLD="" DIM="" RED="" GREEN="" YELLOW="" RESET=""
fi

info() { printf '%s\n' "$*"; }
step() { printf '\n%s==> %s%s\n' "$BOLD" "$*" "$RESET"; }
ok() { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
die() {
  printf '%serror:%s %s\n' "$RED" "$RESET" "$*" >&2
  exit 1
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
EOF
}

# ---------------------------------------------------------------------------
# Prompts. They read from the terminal, so `curl … | bash` can still ask.

has_tty() { { : </dev/tty; } 2>/dev/null; }

# ask <variable> <question> [default]
ask() {
  local __var=$1 question=$2 default=${3:-} answer=""
  if $ASSUME_YES; then
    printf -v "$__var" '%s' "$default"
    return
  fi
  if [ -n "$default" ]; then
    printf '%s %s[%s]%s ' "$question" "$DIM" "$default" "$RESET"
  else
    printf '%s ' "$question"
  fi
  IFS= read -r answer </dev/tty || true
  printf -v "$__var" '%s' "${answer:-$default}"
}

# ask_yes_no <question> <y|n>, succeeds on yes
ask_yes_no() {
  local question=$1 default=$2 hint answer
  if $ASSUME_YES; then
    [ "$default" = y ]
    return
  fi
  if [ "$default" = y ]; then hint="Y/n"; else hint="y/N"; fi
  while true; do
    printf '%s %s[%s]%s ' "$question" "$DIM" "$hint" "$RESET"
    IFS= read -r answer </dev/tty || true
    case "${answer:-$default}" in
      [Yy] | [Yy][Ee][Ss]) return 0 ;;
      [Nn] | [Nn][Oo]) return 1 ;;
      *) info "Please answer y or n." ;;
    esac
  done
}

# choose <variable> <question> <default number> <option>…, sets the chosen option's number
choose() {
  local __var=$1 question=$2 default=$3 i answer
  shift 3
  if $ASSUME_YES; then
    printf -v "$__var" '%s' "$default"
    return
  fi
  info "$question"
  i=1
  for option in "$@"; do
    info "  $i) $option"
    i=$((i + 1))
  done
  while true; do
    printf 'Choose %s[%s]%s ' "$DIM" "$default" "$RESET"
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
port_in_use() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v ss >/dev/null 2>&1; then
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
  ok "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '') with $(docker compose version --short 2>/dev/null || echo 'Compose')"
}

# Lowercase letters, digits, dashes and underscores, as Compose names the project
project_name() {
  basename "$DIR" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-'
}

check_start() {
  step "Checking the host"
  check_docker

  local port
  for port in $(published_ports); do
    if port_in_use "$port" && ! docker compose --project-directory "$DIR" ps -q 2>/dev/null | grep -q .; then
      warn "Port $port is already in use. The containers will not start until it is free."
    fi
  done

  # A new password cannot open a database volume made with an older one
  if $NEW_PASSWORD && docker volume inspect "$(project_name)_speicher-db" >/dev/null 2>&1; then
    warn "The volume $(project_name)_speicher-db exists from an earlier install, but .env had no"
    warn "POSTGRES_PASSWORD. The new password will not open that database. Restore the old"
    warn ".env, or remove the volume to start over: docker volume rm $(project_name)_speicher-db"
    ask_yes_no "Continue anyway?" n || exit 1
  fi

  if [ "$MODE" = public ] && [ "$CADDY" = yes ]; then
    if command -v getent >/dev/null 2>&1; then
      getent hosts "$DOMAIN" >/dev/null 2>&1 ||
        warn "$DOMAIN does not resolve yet. Caddy gets a certificate once it points at this server."
    elif command -v host >/dev/null 2>&1; then
      host "$DOMAIN" >/dev/null 2>&1 ||
        warn "$DOMAIN does not resolve yet. Caddy gets a certificate once it points at this server."
    fi
  fi
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
  step "How will Speicher be reached?"
  if [ -z "$MODE" ]; then
    local choice
    choose choice "Who opens Speicher in the browser?" 1 \
      "Only me, on this machine (http://localhost)" \
      "Others too, on a domain over HTTPS (needs a domain that points at this server)"
    if [ "$choice" = 1 ]; then MODE=local; else MODE=public; fi
  fi

  if [ "$MODE" = public ]; then
    while [ -z "$DOMAIN" ]; do
      ask DOMAIN "Domain for Speicher, e.g. docs.example.com:"
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
      info "Caddy can run next to Speicher and get HTTPS certificates from Let's Encrypt."
      info "It needs ports 80 and 443. Skip it if you already run a reverse proxy, e.g. nginx."
      if ask_yes_no "Set up Caddy for HTTPS?" y; then CADDY=yes; else CADDY=no; fi
    fi
    if [ "$CADDY" = yes ] && [ -z "$ACME_EMAIL" ] && ! $ASSUME_YES; then
      ask ACME_EMAIL "Email for Let's Encrypt notices (optional, Enter to skip):"
    fi
  else
    CADDY=no
  fi

  if [ "$CADDY" = no ] && [ -z "$PORT" ]; then
    local suggestion=3000
    if ! $ASSUME_YES; then
      while port_in_use "$suggestion" && [ "$suggestion" -lt 3100 ]; do suggestion=$((suggestion + 1)); done
      [ "$suggestion" = 3000 ] || info "Port 3000 is in use; $suggestion is free."
    fi
    while true; do
      ask PORT "Port on this machine:" "$suggestion"
      valid_port "$PORT" && break
      warn "The port must be a number from 1 to 65535."
      PORT=""
    done
  fi
  [ -n "$IMAGE_TAG" ] || IMAGE_TAG=$(default_image_tag)
}

# Takes the choices from the files of an earlier install, for the checks and the summary
read_existing() {
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

confirm() {
  step "Summary"
  info "  Directory   $DIR"
  info "  URL         $(public_url)"
  if [ "$MODE" = public ]; then
    if [ "$CADDY" = yes ]; then
      info "  HTTPS       Caddy, with a certificate from Let's Encrypt"
    else
      info "  HTTPS       your own reverse proxy, forwarding to 127.0.0.1:$PORT"
    fi
  fi
  info "  Image       $IMAGE:$IMAGE_TAG"
  if $KEEP_FILES; then
    info "  Files       kept as they are"
  else
    info "  Files       docker-compose.yaml, .env$([ "$CADDY" = yes ] && echo ", Caddyfile")"
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
    info "  backed up $(basename "$1") to $(basename "$1").bak-$stamp"
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
  [ -f "$DIR/.env" ] && backup "$DIR/.env"
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
    ok "kept docker-compose.yaml and .env"
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

start() {
  step "Pulling images"
  if ! compose pull; then
    if compose config --images | while read -r image; do docker image inspect "$image" >/dev/null 2>&1 || exit 1; done; then
      warn "Pulling failed; starting with the images already on this machine."
    else
      die "Pulling the images failed. Check the network, and that the tag $IMAGE_TAG exists."
    fi
  fi

  step "Starting the containers"
  compose up -d

  step "Waiting for Speicher to be ready"
  local waited=0
  # Asks from inside the web container, so it works before DNS or the certificate is ready
  until compose exec -T web node -e \
    "fetch('http://127.0.0.1:3000/-/readyz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))" \
    >/dev/null 2>&1; do
    if [ "$waited" -ge "$READY_TIMEOUT" ]; then
      warn "Speicher is not ready after ${READY_TIMEOUT}s. The last log lines:"
      compose ps >&2 || true
      compose logs --tail 50 migrate web >&2 || true
      die "Speicher did not start. Fix the error above, then run: docker compose up -d"
    fi
    sleep 2
    waited=$((waited + 2))
  done
  ok "Speicher is ready"
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
    info "Opened ${BOLD}$url${RESET} in your browser."
  else
    info "Open ${BOLD}$url${RESET} in your browser."
  fi
  info "The claim page shows a code like QUIET-HERON-4471. Enter it here to prove that"
  info "the browser belongs to whoever runs this server."
  while true; do
    ask code "Code from the claim page (Enter to skip):"
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
  if $CLAIMED; then
    info "Your browser is signed in. Continue the setup there: add an identity provider,"
    info "a content source and the first administrator."
  elif $HAS_ADMIN; then
    info "Speicher runs at ${BOLD}$url${RESET}. It already has an administrator, who can"
    info "sign in there."
  elif [ "$START" = yes ]; then
    info "Open ${BOLD}$url${RESET} and claim the instance. The page shows a command"
    info "to run in $DIR, like:"
    info ""
    info "  docker compose exec web speicher claim <CODE>"
  else
    info "Start Speicher with:"
    info ""
    info "  cd $DIR && docker compose up -d"
    info ""
    info "Then open ${BOLD}$url${RESET} and claim the instance with a command like:"
    info ""
    info "  docker compose exec web speicher claim <CODE>"
  fi
  info ""
  if [ "$MODE" = public ] && [ "$CADDY" = yes ]; then
    info "Caddy gets the certificate once $DOMAIN points at this server and ports 80 and"
    info "443 are open. To check it: curl https://$DOMAIN/-/readyz"
    info ""
  elif [ "$MODE" = public ]; then
    info "Point your reverse proxy at http://127.0.0.1:$PORT and serve $DOMAIN over HTTPS:"
    info "  $DOCS_URL/05-operations/04-reverse-proxy-and-tls.md"
    info ""
  fi
  info "Next: $DOCS_URL/01-quick-start/02-setup-instance.md"
}

main() {
  parse_flags "$@"
  info "${BOLD}Speicher installer${RESET} $(default_image_tag)"
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
