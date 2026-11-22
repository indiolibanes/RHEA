# Telegram sandbox connection

The RHEA workspace links to **Telegram** at `/rhea/library`. It displays the connection check separately from the demonstration catalog. Use a disposable private channel, a dedicated bot and an Access-protected test workspace.

## From the Telegram app

1. Create a private broadcast channel named **RHEA Test Source** and keep ownership on your account. Add a few small posts you own. There is no need for a destination channel during the connection check.
2. Open the official [BotFather](https://t.me/BotFather) account, run `/newbot` and create a bot only for this test. Store the token directly in the sandbox Worker's encrypted secrets. Keep it out of chat messages, URLs in your browser and Git.
3. In the test channel, add the bot to Administrators and leave optional rights off. The check accepts `can_manage_chat` and rejects other enabled privileges, including posting, editing, deleting and adding administrators. If the mobile app does not save that permission profile, stop at this step and record what Telegram allows. Do not grant broader rights to clear the check.

## Operator setup

Deploy `apps/web/telegram-worker` as a separate test Worker using its Wrangler configuration. Keep `workers_dev` and `preview_urls` disabled. Leave Routes and Custom Domains empty. Bind it only from the test Pages Function via **Workers & Pages → Pages test project → Settings → Bindings → Add → Service binding**. Name the binding `RHEA_TELEGRAM_SANDBOX`. Keep the existing Access settings for the test workspace and API audience. The API uses the workspace's exact-origin, verified-subject and configured-branch checks.

| Sandbox Worker private value | Purpose |
| --- | --- |
| `RHEA_TELEGRAM_BOT_TOKEN` | Token issued by BotFather for the test bot. |
| `RHEA_TELEGRAM_CHANNEL_ID` | Signed numeric Bot API chat ID for the single test broadcast channel. Use the exact ID confirmed through private operator tooling. |
| `RHEA_TELEGRAM_OWNER_ID` | Numeric Telegram user ID for the test channel creator. Obtain it through private operator tooling, for example by checking the `creator` returned by `getChatAdministrators` for a channel you own. |
| `RHEA_TELEGRAM_ACCESS_SUB` | Exact Cloudflare Access application-token `sub` of the workspace operator. Confirm through authorized Access identity tooling. An email or Telegram username cannot stand in for it. |

The operator supplies these values through Cloudflare. A local terminal is unnecessary for the person reviewing the tab. Provisioning, including verifying the numeric IDs, is separate from the tab. No D1 migration, user MTProto session, or MCP key is needed for this check.

## Verify from the phone

Sign in to the test workspace, tap **Telegram**, then tap **Verificar conexão**. A successful check confirms the bot, channel and configured creator. Capture the safe state shown on the page. Catalog entries stay synthetic even after verification.

Remove the service binding or disable sandbox mode to stop checks. Remove the test bot from the channel after the trial. Revoke the token in BotFather if it is exposed.

## Service contract

`GET /api/rhea/telegram` reports sandbox configuration state without calling Telegram. A same-origin `POST` with no body requests one diagnostic, using only `getMe`, `getChat` and `getChatMember` on the official Bot API. The Pages API constructs its own internal request and forwards only the verified Access subject. The Worker checks the pinned subject, channel and creator independently. The permitted response contains a fixed state and, for rate limits, an optional retry duration. Provider details and any pinned post data returned by Telegram are discarded. Tests use synthetic upstream responses.

The live check does not fetch history, publish, edit or delete Telegram messages. It does not expose a webhook or MCP tool.

## After the connection check

1. Qualify a separate read-only MTProto reader with a dedicated test participant to load historical posts from the disposable channel.
2. Connect verified snapshots to the Catalog tab and compare orders K and S against the planner.
3. Validate a copy to a fresh private destination with explicit owner approval after synthetic evidence passes. Keep the source intact and compare every affected post, including albums and file accessibility.
