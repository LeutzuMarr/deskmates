#!/bin/bash
# Boots one bot PC: Xvnc, JWM, Chromium, websockify/noVNC, then the agent.
#
# Every non-agent service is restarted if it dies. The agent is different: if it exits, the app
# has lost its only way to drive this PC, so the whole container stops (`docker start` runs this
# script again from a clean process tree next time).
set -uo pipefail

export DISPLAY="${DISPLAY:-:0}"
export HOME="${HOME:-/home/bot}"

RUNTIME_DIR="${DESKMATES_RUNTIME_DIR:-/tmp/deskmates-run}"
CHROMIUM_PROFILE_DIR="/home/bot/data/chromium"
NOVNC_WEB_DIR="/usr/share/novnc"
AGENT_SCRIPT="/opt/deskmates/agent.py"

mkdir -p "$RUNTIME_DIR" "$CHROMIUM_PROFILE_DIR"

log() {
  echo "[start.sh] $*" >&2
}

declare -A PIDS=()

start_xvnc() {
  Xvnc "$DISPLAY" \
    -geometry 1280x800 \
    -depth 24 \
    -rfbport 5900 \
    -SecurityTypes None \
    -localhost yes \
    -AlwaysShared \
    -dpi 96 \
    >"$RUNTIME_DIR/xvnc.log" 2>&1 &
  PIDS[xvnc]=$!
}

start_jwm() {
  jwm >"$RUNTIME_DIR/jwm.log" 2>&1 &
  PIDS[jwm]=$!
}

start_chromium() {
  # DevTools runs on loopback port 9223: Chromium >= ~130 clamps its DevTools listener to
  # loopback and ignores --remote-debugging-address, and if it shared port 9222 with the
  # forwarder below its own bind would fail (EADDRINUSE). cdp-fwd.py listens on 0.0.0.0:9222 -
  # the port LocalWslHost publishes - and pipes to 127.0.0.1:9223, so the host's CDP endpoint
  # keeps working while Chromium still binds nothing but loopback. Reachability is kept to the
  # host by the 127.0.0.1-only publish plus this container's own isolated Docker network (see
  # local-wsl-host.ts and README.md's Security section).
  chromium \
    --user-data-dir="$CHROMIUM_PROFILE_DIR" \
    --remote-debugging-port=9223 \
    --no-first-run \
    --no-default-browser-check \
    --disable-fre \
    --disable-sync-preferences \
    --no-sandbox \
    --disable-gpu \
    --disable-dev-shm-usage \
    --window-size=1280,800 \
    --start-maximized \
    about:blank \
    >"$RUNTIME_DIR/chromium.log" 2>&1 &
  PIDS[chromium]=$!
}

start_cdp_fwd() {
  python3 /opt/deskmates/cdp-fwd.py >"$RUNTIME_DIR/cdp-fwd.log" 2>&1 &
  PIDS[cdp_fwd]=$!
}

start_websockify() {
  # Bind is explicit (0.0.0.0, all interfaces in this container) for the same reason as Chromium's
  # --remote-debugging-address above: the host's `-p 127.0.0.1:<host>:6900` publish needs a
  # non-loopback bind in here to be reachable at all. Unlike before this container also sits on
  # its own isolated Docker network (see local-wsl-host.ts), so binding every interface no longer
  # means every other bot can reach it too - nothing else is attached to this network.
  websockify --web="$NOVNC_WEB_DIR" 0.0.0.0:6900 localhost:5900 \
    >"$RUNTIME_DIR/websockify.log" 2>&1 &
  PIDS[websockify]=$!
}

start_agent() {
  python3 "$AGENT_SCRIPT" >"$RUNTIME_DIR/agent.log" 2>&1 &
  PIDS[agent]=$!
}

shutting_down=0
shutdown() {
  [ "$shutting_down" = "1" ] && return
  shutting_down=1
  log "shutting down"
  for name in "${!PIDS[@]}"; do
    kill "${PIDS[$name]}" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT

wait_for_socket() {
  # Waits (briefly) for Xvnc's Unix socket, so JWM/Chromium/websockify don't all race it on cold start.
  local display_num="${DISPLAY#:}"
  display_num="${display_num%%.*}"
  for _ in $(seq 1 50); do
    [ -S "/tmp/.X11-unix/X${display_num}" ] && return 0
    sleep 0.2
  done
  return 1
}

log "starting Xvnc on $DISPLAY"
start_xvnc
wait_for_socket || log "Xvnc didn't come up within 10s - starting the rest anyway, the watchdog will retry"

log "starting JWM"
start_jwm

log "starting Chromium"
start_chromium

log "starting the CDP forwarder on 9222"
start_cdp_fwd

log "starting websockify/noVNC on 6900"
start_websockify

log "starting the agent on 8700"
start_agent

# Watchdog loop: restart any service that dies, except the agent (see header comment).
while true; do
  sleep 2
  for name in xvnc jwm chromium cdp_fwd websockify agent; do
    pid="${PIDS[$name]:-}"
    [ -z "$pid" ] && continue
    if ! kill -0 "$pid" 2>/dev/null; then
      if [ "$name" = "agent" ]; then
        log "agent exited, shutting the PC down"
        shutdown
      fi
      log "$name (pid $pid) died, restarting it"
      "start_$name"
    fi
  done
done
