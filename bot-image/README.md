# Bot PC image

The small Linux computer each Deskmates bot gets: a desktop (Xvnc + JWM), a browser (Chromium,
open for control over CDP), and a Python agent service the app drives it through. Built from
`debian:stable-slim`. See the design spec, section 5.8, for the product picture, and
`src/core/bots/local-wsl-host.ts` for the code that actually creates and runs containers from
this image day to day - that file, not this one, is the source of truth for container names,
mounts, ports and the token.

## What's inside

- **TigerVNC** (`Xvnc`) - the display and VNC server, `:0`, 1280x800, depth 24.
- **JWM** - a minimal window manager, so Chromium and any other window has somewhere to live.
- **Chromium** - opened with remote debugging on port `9222`, reachable on every interface
  *inside the container* (via `cdp-fwd.py` - see Security below for why that's the correct setup,
  not a mistake; Chromium itself clamps its DevTools listener to loopback), and a persistent
  profile at `/home/bot/data/chromium`, so logins survive a container restart.
- **xdotool** - mouse/keyboard control and window queries, used by the agent.
- **x11-apps** (`xwd` only) - screen capture; the agent turns its output into a PNG itself, since
  there's no image library in the package list.
- **DejaVu and Noto fonts** - broad script coverage for whatever a bot reads.
- **websockify + noVNC** - serves the noVNC web client and proxies it to Xvnc's VNC port, both on
  one port (6900).
- **`agent.py`** - a stdlib-only Python HTTP service on port 8700. No pip packages, nothing
  downloaded at runtime.
- **`cdp-fwd.py`** - a stdlib-only Python TCP forwarder: listens on `0.0.0.0:9222` (the port
  published to the host) and pipes to Chromium's loopback DevTools listener on `9223`, so the
  published CDP port is reachable from the host.
- **`start.sh`** - the container's entrypoint: starts everything above, restarts any of them that
  dies, and stops the container if the agent itself exits (see its header comment for why).

Non-root throughout: everything runs as `bot` (uid 1000), home `/home/bot`. A bot's persistent
data lives at `/home/bot/data` (bind-mounted per bot); files bots hand off to each other live at
`/shared` (bind-mounted once, shared by every bot).

Rough image size: a few hundred MB, dominated by Chromium; there's no browser-engine alternative
that's meaningfully smaller and still gets a real, controllable Chromium/CDP surface.

## Building and running by hand

From the repo root:

```sh
docker build -t deskmates/bot-pc:local bot-image/
```

Running it the way `LocalWslHost` does (one bot's own PC, on its own isolated network; see
`runContainer` in `local-wsl-host.ts` for the exact argument list this mirrors):

```sh
docker network create deskmates-bot-test-net
docker run -d --name deskmates-bot-test \
  --network deskmates-bot-test-net \
  --memory 1024m --cpus 2 \
  -p 127.0.0.1:8700:8700 \
  -p 127.0.0.1:6900:6900 \
  -p 127.0.0.1:9220:9222 \
  -v "$PWD/data/pcs/test:/home/bot/data" \
  -v "$PWD/data/shared:/shared" \
  -e DESKMATES_TOKEN=dev-token \
  deskmates/bot-pc:local
```

Then:

- Live desktop: open `http://127.0.0.1:6900/vnc.html` in a browser.
- Agent health check: `curl -H "X-Deskmates-Token: dev-token" http://127.0.0.1:8700/health`.
- Chromium DevTools targets: `http://127.0.0.1:9220/json/version` (no token - this is Chromium's
  own CDP endpoint, not the agent).

Tear down with `docker rm -f deskmates-bot-test && docker network rm deskmates-bot-test-net`.

In the real app, `LocalWslHost` runs the equivalent `docker network create` and `docker run` inside
the `deskmates-engine` WSL distro (`wsl -d deskmates-engine -- docker ...`), picks the host ports
from each bot's slot (`AGENT_BASE_PORT + slot`, etc. - see `host-paths.ts`), names the network after
the container (`networkNameFor`, also in `host-paths.ts`), and generates the token itself per PC
(`PcRegistry`, in `host-registry.ts`). `reset`/`delete` remove both the container and its network.
`buildLocal()` runs `docker build` against this folder when the image can't be pulled from the
registry.

## Ports

| Port | What | Bound inside the container | Exposed to the host? |
|---|---|---|---|
| 8700 | Agent HTTP API | `0.0.0.0` (see Security) | Yes, `127.0.0.1` only |
| 6900 | noVNC (web client + WebSocket-to-VNC proxy, same port) | `0.0.0.0` (see Security) | Yes, `127.0.0.1` only |
| 9222 | Chromium DevTools Protocol | `0.0.0.0` (via `cdp-fwd.py`) | Yes, `127.0.0.1` only |
| 5900 | Xvnc's own VNC port | `127.0.0.1` (`-localhost yes`) | No - only websockify, inside the same container, ever connects to it |

`LocalWslHost` publishes 8700/6900/9222 on the host's `127.0.0.1` and never on `0.0.0.0`; nothing
here changes that, and this image never opens a port beyond the three above. Inside the container,
though, each of those three is reachable on every interface (`0.0.0.0`): the agent and websockify
bind it directly, and Chromium's CDP gets it through `cdp-fwd.py` (a small TCP forwarder that
listens on `0.0.0.0:9222` and pipes to Chromium's loopback DevTools listener) - see Security for why
that pairing is correct rather than contradictory.

## Security

- **Two independent layers, not one.** Reachability of the agent, CDP and noVNC ports depends on
  both of these together, never on the bind address alone:
  1. **Host-side: `127.0.0.1` only.** `LocalWslHost` (`local-wsl-host.ts`) publishes 8700/6900/9222
     with `-p 127.0.0.1:<host>:<container>`, never `0.0.0.0` - so nothing on the network can reach
     them, only processes on the same Windows machine.
  2. **Network-side: one isolated Docker network per container.** `LocalWslHost` creates a
     dedicated network for each bot's container (`docker network create`, named by
     `networkNameFor` in `host-paths.ts`) and attaches the container to it with `--network`,
     instead of Docker's shared default bridge. Nothing else is ever attached to that network, so
     no other bot's container - or anything else on the `deskmates-engine` Docker daemon - can
     reach these ports either, no matter what they bind to inside the container. `reset`/`delete`
     remove the network along with the container; `/shared` (a bind mount, not a network path)
     stays the only deliberate crossover between bots.

  Inside the container itself, the agent, websockify and mid/HD Chromium's CDP are all reachable
  on `0.0.0.0` (every interface *in the container's own network namespace*), not `127.0.0.1`. That's
  deliberate, not a weakening: Docker delivers a published port's inbound traffic to the
  container's bridge-facing address, never to its loopback, so a loopback-only bind in here would
  make a service unreachable even through the host's own 127.0.0.1-only publish above (this was a
  real bug in an earlier version of this image - the agent and CDP were bound to 127.0.0.1 inside
  the container and would not have been reachable from the host at all once a real container ran).
  The CDP wrinkle is that Chromium itself always clamps its DevTools listener to loopback and
  ignores `--remote-debugging-address` (>= ~130), so `cdp-fwd.py` listens on `0.0.0.0:9222` and
  pipes to Chromium's `127.0.0.1:9223` (Chromium is started with `--remote-debugging-port=9223`
  so the two never collide on 9222); the two security layers above are what actually fence these
  ports off from the network and from other bots, and the bind address inside the container only
  controls whether the *host* can reach them at all, not who else can.
- **Every agent request needs a token.** `X-Deskmates-Token` must equal the `DESKMATES_TOKEN`
  environment variable, checked with a constant-time comparison
  (`hmac.compare_digest`) so response timing can't be used to guess it. A request with a missing
  or wrong token gets `401` and is never logged with header values - the token never reaches a log
  line, in this image or in the app.
- **No VNC password, by a considered decision.** Xvnc runs with `-SecurityTypes None`. Before the
  per-container network above existed, that was a real gap: every bot's container shared Docker's
  default bridge, so any other bot could reach `<sibling-ip>:6900` directly and get a live,
  unauthenticated noVNC session onto that bot's screen. With each container now on its own network
  that nothing else is attached to, plus the host-side port staying `127.0.0.1`-only, the same
  reachability argument the design spec makes for this component (section 5.8: "The VNC,
  browser-debugging and bot-agent ports listen only on 127.0.0.1") holds for real, and matches the
  already-accepted threat model for CDP (port 9222), which has no authentication of its own either.
  We chose not to add a VNC password on top of that: doing so would need the noVNC web client (the
  `<iframe>` the renderer embeds) to also learn and submit a per-bot password to unlock the live
  view, which is a renderer-side change outside a network/logging fix, and without it a generated
  password would just break "Take over" instead of adding real defense. If a later change reuses
  `deskmates-engine`'s Docker daemon for anything that isn't one container per isolated network -
  or `/shared`'s bind-mount crossover grows into something richer - this decision should be
  revisited alongside that change, most likely by having `endpoints()` return the VNC password the
  way it already returns the agent token, and having the renderer pass it through to noVNC.
- **The AI never receives the user's passwords.** Bots don't get a "type your password" tool.
  Logging in to a site happens through the app's **Take over**, which hands the user the mouse and
  keyboard directly over the same noVNC view the AI would otherwise use - the credentials never
  pass through the agent, a tool call, or a model prompt.
- **File access is fenced.** `/files` only ever resolves inside `/home/bot/data` or `/shared`; the
  resolved path is checked after following symlinks, so a symlink planted inside either folder
  can't be used to read or write outside it.
- **Commands are argument lists, never shell strings.** Both `/exec` and every xdotool call the
  agent makes run through `subprocess` with an explicit argument list - nothing is ever
  interpolated into a shell command line, so there's no shell-quoting failure mode to exploit.
  `/exec` output is capped at 100 KB per stream and the command is killed on timeout.

## Manual smoke test

With the container above running:

```sh
TOKEN=dev-token
curl -H "X-Deskmates-Token: $TOKEN" http://127.0.0.1:8700/health
curl -H "X-Deskmates-Token: $TOKEN" http://127.0.0.1:8700/screenshot -o screenshot.png
curl -H "X-Deskmates-Token: $TOKEN" -X POST -H "Content-Type: application/json" \
  -d '{"action":"move","x":100,"y":100}' http://127.0.0.1:8700/input
curl -H "X-Deskmates-Token: $TOKEN" -X PUT --data 'hello' \
  "http://127.0.0.1:8700/files?path=data/hello.txt"
curl -H "X-Deskmates-Token: $TOKEN" "http://127.0.0.1:8700/files?path=data/hello.txt"
```

## Confirming the network model with a real container

Nothing in this repo's test suite runs Docker (see Automated tests below), so the bind-address fix
and the per-bot network isolation above are reasoned from Docker/Linux networking fundamentals, not
proven end to end here. Once WSL2 and Docker are available, this settles both at once - run it from
the repo root:

```sh
docker build -t deskmates/bot-pc:local bot-image/

# Two isolated networks, one per simulated bot - exactly what LocalWslHost.runContainer does.
docker network create deskmates-sim-a-net
docker network create deskmates-sim-b-net
docker run -d --name deskmates-sim-a --network deskmates-sim-a-net \
  --memory 1024m --cpus 2 \
  -p 127.0.0.1:8700:8700 -p 127.0.0.1:6900:6900 -p 127.0.0.1:9220:9222 \
  -e DESKMATES_TOKEN=token-a deskmates/bot-pc:local
docker run -d --name deskmates-sim-b --network deskmates-sim-b-net \
  --memory 1024m --cpus 2 \
  -p 127.0.0.1:8701:8700 -p 127.0.0.1:6901:6900 -p 127.0.0.1:9221:9222 \
  -e DESKMATES_TOKEN=token-b deskmates/bot-pc:local
sleep 5   # let Xvnc/Chromium/websockify/agent finish starting

# 1. The agent and CDP must be reachable from the HOST through the published ports - this is the
#    "may not work at all" risk: before this fix, both binds were 127.0.0.1 *inside* the container,
#    which a docker -p publish cannot reach, so these would have failed with connection-refused.
curl -sf -H "X-Deskmates-Token: token-a" http://127.0.0.1:8700/health && echo "A agent OK"
curl -sf http://127.0.0.1:9220/json/version >/dev/null && echo "A CDP OK"
curl -sf -o /dev/null http://127.0.0.1:6900/vnc.html && echo "A noVNC OK"

# 2. Bot B's container must NOT be able to reach bot A's agent or VNC port - this is the
#    cross-bot-hijack risk: before per-bot networks, both containers sat on the same default
#    bridge and this would have succeeded.
A_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' deskmates-sim-a)
docker exec deskmates-sim-b sh -c "curl -m 3 -sf http://$A_IP:8700/health" \
  && echo "ISOLATION FAILED: B reached A's agent" || echo "isolation OK: B could not reach A's agent"
docker exec deskmates-sim-b sh -c "curl -m 3 -sf -o /dev/null http://$A_IP:6900/vnc.html" \
  && echo "ISOLATION FAILED: B reached A's noVNC" || echo "isolation OK: B could not reach A's noVNC"

# 3. Each container still needs real internet access to browse - confirms the isolated network
#    didn't accidentally cut outbound access along with inter-container access.
docker exec deskmates-sim-a sh -c "curl -m 5 -sf -o /dev/null -w '%{http_code}\n' https://example.com"

# Teardown
docker rm -f deskmates-sim-a deskmates-sim-b
docker network rm deskmates-sim-a-net deskmates-sim-b-net
```

Expect: both health/CDP/noVNC checks in step 1 to succeed, both isolation checks in step 2 to print
"isolation OK" (the `curl` inside the container should fail to connect - refused or timed out), and
step 3 to print `200`. If step 1 fails, the bind-address fix didn't take; if step 2 prints "ISOLATION
FAILED", the per-bot `--network` wiring in `local-wsl-host.ts` isn't taking effect and needs
re-checking before this ships.

## Automated tests

`tests/bots/agent-service.test.ts` runs `agent.py` directly (no Docker) against a fake `xdotool`
on `PATH` and temporary data/shared folders, and covers auth, every `/input` action, `/exec`,
`/files` (including path-traversal rejection), `/windows`, and an unknown route. It skips the
`/screenshot` assertion when no real X server is reachable, and skips the whole file with a clear
message if no Python 3 interpreter is available. It doesn't build or run this Dockerfile - that
needs Docker, which isn't part of this repo's test matrix (see the stage-2 plan: "No test may
require WSL, Docker or the network"). `tests/bots/local-wsl-host.test.ts` asserts the exact
`docker network create` / `docker run --network ...` / `docker network rm` command lines
`LocalWslHost` issues, against a fake Docker that tracks network existence the way the real one
would - but a fake can only prove the *commands* are right, not that Docker's real behavior matches
what this file assumes about them; see "Confirming the network model with a real container" above
for that.
