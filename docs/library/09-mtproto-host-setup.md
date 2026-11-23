# MTProto sandbox host setup

The adapter needs a Linux host with Docker Compose, a durable Docker volume, and outbound access to Telegram and Cloudflare. Run one instance for the disposable channel. The host can be managed remotely. The final enrollment and catalog test run in the phone browser and the Telegram app.

The Cloudflare resources staged for this pilot are the `rhea-telegram-sandbox` remotely managed Tunnel and the **RHEA Telegram Sandbox Adapter** Access application. The hostname reserved in their configuration is `rhea-telegram-test.horologiarius.com`. The ingress requires the dedicated Access audience and targets `http://127.0.0.1:8789`. The hostname has no DNS route and the Access application has no active policy. The rest of this document brings the sandbox online after a host is available.

## On the remote host

1. Place the RHEA checkout on the host. In `apps/web/telegram-mtproto/deploy`, create a private `secrets/` directory. Copy `reader.env.example` to `secrets/reader.env`. Enter the Telegram API ID and hash, the disposable channel ID and invite, the pinned test account and verified workspace Access subject. Use separate random 32-byte values encoded as 43-character unpadded base64url for the bridge key and session encryption key. See the [complete variable list](07-mtproto-sandbox.md).
2. Obtain the connector token from the staged Tunnel's **Add a replica** screen. Store it as the only line of `secrets/tunnel-token`. Keep the directory private on the host. Docker Compose mounts these file-backed secrets read-only. Set `reader.env` owner to UID/GID `1000:1000` and `tunnel-token` owner to `65532:65532`, both with mode `0400`, so only their respective service process can read them. The compose files never include the values.
3. From the deployment directory, run `docker compose up -d --build --wait reader`. The health check runs against loopback. There is no public container port. The encrypted session file is kept in the local `session` volume and survives ordinary container restarts. Keep the deployment at one replica.
4. Run `docker compose --profile tunnel up -d --wait` and confirm the Tunnel connector becomes healthy in Zero Trust. The connector shares only the reader's network namespace and reaches the Node listener via loopback.

## Activate the protected test route

1. Create a dedicated, expiring Cloudflare Access Service Token. Attach only that token via a **Service Auth** policy on **RHEA Telegram Sandbox Adapter**. Keep the workspace's human Access policy separate. Create a proxied CNAME for the exact sandbox hostname to the staged Tunnel target. Leave other DNS records and the production workspace untouched.
2. In the separate sandbox Pages environment set `RHEA_TELEGRAM_MTPROTO_ORIGIN` to `https://rhea-telegram-test.horologiarius.com` and set `RHEA_TELEGRAM_CF_CLIENT_ID`, `RHEA_TELEGRAM_CF_CLIENT_SECRET` and `RHEA_TELEGRAM_MTPROTO_KEY`. Use the same bridge key as the Node reader. The Telegram API hash, phone and session key stay on the host.
3. Verify a public request to the adapter cannot reach the origin without the Service Token. Open **Telegram → Histórico do Telegram** in the protected sandbox workspace. Use the mobile acceptance steps in the [MTProto runbook](07-mtproto-sandbox.md) to enroll, read three synthetic posts, compare the K/S order and revoke the test session.

## Stop the sandbox

Disconnect from the test workspace before stopping the services. Revoke the Telegram device from the official app if logout is pending. Remove the sandbox DNS record or Service Auth policy to stop access. On the host, `docker compose --profile tunnel down` stops the services while retaining the encrypted volume and the private configuration files for operator review.

References: [Cloudflare Tunnel connector](https://developers.cloudflare.com/tunnel/get-started/), [Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/), and [Docker Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/).
