FROM node:24-bookworm-slim

WORKDIR /opt/rhea
COPY telegram-mtproto/package.json telegram-mtproto/package-lock.json ./telegram-mtproto/
RUN cd telegram-mtproto && npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && install -d -o node -g node -m 0700 /var/lib/rhea
COPY telegram-mtproto/*.mjs ./telegram-mtproto/
COPY src/rhea/library/mtproto-contract.mjs src/rhea/library/forum-contract.mjs src/rhea/library/telegram-contract.mjs src/rhea/library/catalog.mjs src/rhea/library/live-catalog.mjs src/rhea/library/planner.mjs ./src/rhea/library/

ENV PORT=8789 \
    RHEA_TELEGRAM_MTPROTO_MODE=sandbox \
    RHEA_TELEGRAM_SESSION_FILE=/var/lib/rhea/session.enc
USER node
CMD ["sh", "-c", "if [ -f /run/secrets/reader.env ]; then exec node --env-file=/run/secrets/reader.env telegram-mtproto/server.mjs; else exec node telegram-mtproto/server.mjs; fi"]
