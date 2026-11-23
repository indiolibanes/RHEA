# Read-only MTProto sandbox

The panel at `/rhea/library` enrolls a test Telegram user inside the existing Cloudflare Access boundary. The Pages Function sends only a verified Access subject to a separately authenticated Node service. The existing Bot API sandbox remains available for bot diagnostics. It is independent of historical reads.

## Exact deployment settings

Use a separate Access-protected sandbox Pages site. Its existing `RHEA_PUBLIC_ORIGIN`, `RHEA_PRODUCTION_BRANCH`, runtime branch if required, `ACCESS_TEAM_DOMAIN` and `RHEA_ACCESS_AUD` target that site and the Access application protecting `/api/rhea/*`. Existing Drive settings are unrelated.

| Sandbox Pages setting | Type | Value |
| --- | --- | --- |
| `RHEA_TELEGRAM_MTPROTO_ORIGIN` | Variable | Exact HTTPS origin for the Node adapter's Tunnel hostname. No trailing slash or path. |
| `RHEA_TELEGRAM_CF_CLIENT_ID` | Secret | Service token Client ID for the adapter's Access application. |
| `RHEA_TELEGRAM_CF_CLIENT_SECRET` | Secret | Matching service token Client Secret. |
| `RHEA_TELEGRAM_MTPROTO_KEY` | Secret | A dedicated 32-byte random value encoded as 43 unpadded base64url characters. Set the same value on Node. |

Create a separate Access application for the adapter hostname. Add a **Service Auth** policy including only the dedicated service token. Configure a Cloudflare Tunnel on the private Node host and map that hostname to `http://127.0.0.1:8789`. Require access-token validation at the Tunnel using that application's audience. Keep the Node port on loopback. Store the Tunnel connector token on the host when using a remotely managed tunnel. The Pages function uses a fixed HTTPS destination and refuses redirects. This path needs no new Worker binding or D1 migration. The optional `RHEA_TELEGRAM_SANDBOX` binding continues to serve the earlier Bot API probe only.

| Isolated Node setting | Type | Value |
| --- | --- | --- |
| `RHEA_TELEGRAM_MTPROTO_MODE` | Variable | `sandbox` |
| `RHEA_TELEGRAM_API_ID` | Secret | The API ID registered for the RHEA MTProto application. |
| `RHEA_TELEGRAM_API_HASH` | Secret | The Telegram application API hash. |
| `RHEA_TELEGRAM_ACCESS_SUB` | Private setting | Exact `sub` from the approved operator's workspace Access token. |
| `RHEA_TELEGRAM_OWNER_ID` | Private setting | Numeric Telegram user ID of the enrolled test account. |
| `RHEA_TELEGRAM_PHONE` | Secret | International E.164 phone number for that account. |
| `RHEA_TELEGRAM_CHANNEL_ID` | Private setting | Bare numeric MTProto channel ID, as shown in a private `t.me/c/<id>/<message>` link. |
| `RHEA_TELEGRAM_CHANNEL_INVITE` | Secret | A valid private invite in `https://t.me/+…` form, for exactly the test channel. |
| `RHEA_TELEGRAM_MTPROTO_KEY` | Secret | Same dedicated bridge key as Pages. |
| `RHEA_TELEGRAM_SESSION_KEY` | Secret | A separate random 32-byte value encoded as 43 unpadded base64url characters. It stays on Node. |
| `RHEA_TELEGRAM_SESSION_FILE` | Variable | Absolute file path under an existing private persistent directory owned by the service account, with directory mode `0700`. |
| `PORT` | Variable, optional | Loopback port, default `8789`. Match the Tunnel origin port if you override it. |

Run one Node.js 24 process for this sandbox so enrollment memory and the encrypted file have one writer. Install dependencies in `apps/web/telegram-mtproto` with `npm ci --ignore-scripts` and run `npm start` using the host's private environment. The host needs outbound MTProto connectivity to Telegram data centers. Serve the built Pages sandbox separately. Keep request body tracing disabled across Pages, Access and Node. The adapter emits no credential, response-body or raw provider logs.

Session envelopes use AES-256-GCM with fresh nonces and associated data for the Access subject, Telegram user, channel and application. Use a separate persistent directory from other RHEA services. Only an authorized session is persisted. Pending code material stays in memory for five minutes. Verification codes and 2FA passwords are passed directly to Telegram and are never persisted. Changing the bound identity or encryption key invalidates existing envelopes. Revoke the old device before reprovisioning.

## Mobile-only setup and acceptance

1. In the Telegram app, use a dedicated permitted test account and create or join one disposable **private broadcast channel**. Add three small original posts in this order: `Series: Solar Talon | S01E01`, `Series: Kestrel Flight | S01E02` and `Series: Kestrel Flight | S01E01`. Optionally add an original two-photo album with a series label in its first caption.
2. Copy a private post link to identify the bare channel ID and generate a restricted invite for the test channel. Configure those values through the Node host's private settings. The operator supplies the pinned Telegram user ID and Access subject from authorized identity tooling. Enter the API ID and hash only in the Node host's secret settings. The operator performs the initial sandbox provisioning separately.
3. In the same phone's browser, sign into the Access-protected sandbox and open **Telegram → Histórico do Telegram → Enviar código**. Retrieve the code from the official Telegram app, return to the browser and enter it in the protected form. If Telegram requires 2FA, complete the second form on the same page. This version supports codes delivered in the Telegram app. If Telegram requests another method, stop before changing account or channel settings.
4. Tap **Ler histórico**. Confirm that the demo is replaced by the authorized test channel and that the Telegram post links point to the disposable channel. In **Prévia da reordenação**, select **K** and confirm Episode 01 precedes Episode 02 in the proposed order. Select **S** and verify Solar Talon. The filter narrows the two order lists while the plan counts cover the entire imported snapshot.
5. Tap **Desconectar Telegram** and verify that the catalog returns to the demo and the RHEA device disappears under **Telegram → Settings → Devices**. If remote logout fails, terminate the device there. Revoke the test invite when the exercise is complete.

No local terminal or second phone is needed for the browser acceptance flow. No assistant receives MTProto credentials or has access to the enrollment or inventory route.

## Inventory and planner boundary

The adapter validates the enrolled Telegram account and checks the configured invite without joining it. It accepts only an existing membership in the pinned private broadcast channel. It fetches up to 500 historical posts, compares the latest message and Telegram channel update state across the read, and reports capped or uncertain coverage. It records bounded text and document metadata with Telegram album IDs. It never downloads media. Series assignment requires a `Series: Title` first line with an optional `| S01E02` suffix. Unassigned posts remain visible for local review. The source exposes private message links only to the authenticated workspace.

The projected snapshot uses the existing Library model. Data lives in the browser for this stage. Library D1 migration `0004_library.sql` remains the schema for future durable snapshots and approvals. There are no D1 writes, public MCP tools, publishing, copying or deleting messages. Every real item has unknown or protected copy status. The current planner renders proposed order but cannot issue a write request.

CI verifies synthetic TL results, mock app-code and 2FA, response redaction, wrong-recipient rejection, encrypted storage, read-only pagination and a mobile browser exercise. A real disposable Telegram trial requires separate sandbox deployment and the owner's in-app enrollment. Never use the production anime channel for that trial.

References: [Teleproto authentication](https://docs.teleproto.dev/authentication), [Telegram invite validation](https://core.telegram.org/method/messages.checkChatInvite), [Telegram history](https://core.telegram.org/method/messages.getHistory), [Cloudflare Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/).
