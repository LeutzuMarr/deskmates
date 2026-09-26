# Bot PC image: the small Linux computer each Deskmates bot gets - a desktop, a browser, and the
# agent service the app drives it through. See docs/superpowers/specs/2026-09-18-deskmates-design.md
# section 5.8, and bot-image/README.md for how this is built, run and secured.
FROM debian:stable-slim

ENV DEBIAN_FRONTEND=noninteractive

# x11-apps is here only for `xwd`, which agent.py shells out to for /screenshot (there's no PNG
# encoder in the package list, so agent.py hand-rolls one from xwd's raw output - see agent.py).
RUN apt-get update && apt-get install -y --no-install-recommends \
      tigervnc-standalone-server \
      jwm \
      chromium \
      xdotool \
      x11-apps \
      fonts-dejavu-core \
      fonts-noto-core \
      python3 \
      websockify \
      novnc \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 1000 --shell /bin/bash bot \
    && mkdir -p /home/bot/data /shared /tmp/.X11-unix \
    && chmod 1777 /tmp/.X11-unix \
    && chown -R bot:bot /home/bot /shared

COPY --chown=bot:bot start.sh agent.py cdp-fwd.py /opt/deskmates/
RUN chmod +x /opt/deskmates/start.sh /opt/deskmates/agent.py /opt/deskmates/cdp-fwd.py

USER bot
WORKDIR /home/bot
ENV HOME=/home/bot DISPLAY=:0

# Fixed container-side ports (see AGENT_CONTAINER_PORT/NOVNC_CONTAINER_PORT/CDP_CONTAINER_PORT in
# src/core/bots/host-paths.ts) - LocalWslHost maps each to a per-bot host port, always 127.0.0.1-only.
EXPOSE 8700 6900 9222

ENTRYPOINT ["/opt/deskmates/start.sh"]
