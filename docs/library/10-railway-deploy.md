# Railway deployment for the read-only Telegram sandbox

This is an alternative deployment target for the isolated MTProto reader documented in [07-mtproto-sandbox.md](07-mtproto-sandbox.md). It does not replace the RHEA web workspace, Cloudflare Access, the MCP gateway, or the original Docker Compose deployment.

## Deployment boundary

- Deploy only the reader from the existing RHEA GitHub repository. **Root Directory:** `/apps/web`. **Dockerfile Path:** `/apps/web/telegram-mtproto/deploy/Dockerfile.railway`. Verify the build log uses the custom Dockerfile, not Railpack.
- Use one replica, one private Railway service, and no Railway public domain or TCP proxy. Do not create a browser-facing MTProto endpoint.
- The reader listens on `0.0.0.0:8789` in its Railway container to accept traffic from the project's private network. Requests still require the application bridge key and verified Cloudflare Access actor. The original Docker Compose build continues to default to loopback.
- Store encrypted session material only in a dedicated persistent Railway Volume mounted at `/var/lib/rhea`. The Railway Dockerfile briefly starts as root to set ownership and mode of the mounted directory, then executes Node as the unprivileged `node` account via `gosu`.
- On initial setup, leave the volume pending until the user approves any applicable resource charges and ensures that the private runtime is ready. A volume is not a backup; keep a separate recovery and revocation procedure.

## Service configuration

Set these non-secret variables: `RHEA_TELEGRAM_MTPROTO_MODE=sandbox`, `RHEA_TELEGRAM_SESSION_FILE=/var/lib/rhea/session.enc`, and `PORT=8789`. The Railway Dockerfile sets `RHEA_TELEGRAM_BIND_HOST=0.0.0.0` by default; do not expose this port to the public internet.

Add all required Telegram identity inputs and private secrets as listed in [07-mtproto-sandbox.md](07-mtproto-sandbox.md), particularly `RHEA_TELEGRAM_API_ID`, `RHEA_TELEGRAM_API_HASH`, `RHEA_TELEGRAM_PHONE`, `RHEA_TELEGRAM_OWNER_ID`, `RHEA_TELEGRAM_CHANNEL_ID`, `RHEA_TELEGRAM_CHANNEL_INVITE`, `RHEA_TELEGRAM_ACCESS_SUB`, `RHEA_TELEGRAM_MTPROTO_KEY`, and `RHEA_TELEGRAM_SESSION_KEY`.

Generate independent cryptographically random 32-byte unpadded base64url keys for the bridge and session; never derive one from the other. The bridge key is shared with the protected Pages endpoint, whereas the session key never leaves the reader. Put values into Railway's private/sealed variable settings, not GitHub, chat, build arguments, logs, or the public RHEA MCP worker.

## Cloudflare Tunnel and Access

Reuse the already-staged `rhea-telegram-sandbox` tunnel and `RHEA Telegram Sandbox Adapter` Access application.

Run `cloudflared` as a **separate private Railway service in the same project/environment** using the existing tunnel's remotely managed connector token. Its origin should be the reader's internal Railway DNS hostname on port `8789`, not `127.0.0.1` in the tunnel container. Confirm the exact internal host using Railway's private network service details.

Configure an Access **Service Auth** policy restricted to a dedicated short-lived service token on the test adapter hostname. Set the DNS route and ensure unauthenticated requests to that hostname are denied. Only then configure the separately Access-protected Pages sandbox with `RHEA_TELEGRAM_MTPROTO_ORIGIN`, `RHEA_TELEGRAM_CF_CLIENT_ID`, `RHEA_TELEGRAM_CF_CLIENT_SECRET`, and the same `RHEA_TELEGRAM_MTPROTO_KEY`.

The browser uses the same-origin protected Pages API, not the Railway private address directly.

## Verification and safety

1. Build using `Dockerfile.railway`; confirm the container starts and the private health check succeeds. A successful image build is not a working MTProto connection.
2. Test on a disposable private Telegram channel containing only synthetic, owned files. Validate owner/account matching, read-only history, A–Z catalog and K/S preview. Do not use the real anime channel during qualification.
3. Disconnect in the RHEA interface and confirm revocation from the official Telegram application's **Devices** view. Preserve audit evidence without storing any session or code.
4. Keep copies, publications, and deletions disabled. Inventory remains limited to 500 posts in this prototype; an uncapped full-library reflow requires subsequent paginated inventory, persistent snapshots, review and safety qualification.

No production merge or real channel action is part of this setup.
