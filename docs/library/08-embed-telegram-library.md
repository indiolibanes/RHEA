# Embed the Library in an existing Telegram tab

Use the same Astro component for the standalone Library and an existing Access-protected workspace. The component contains phone verification, two-step verification, read-only history, the A–Z catalog and the K/S reordering preview.

Copy `apps/web/src/rhea/library` as a unit into the target web application to keep the catalog, planner and response contract on the same version. In the existing Telegram view, render the component once.

```astro
---
import TelegramLibrary from '../../rhea/library/TelegramLibrary.astro';
---
<TelegramLibrary endpoint="/api/relay/telegram-mtproto" autoLoad={false} />
```

After the tab becomes visible, dispatch `rhea:telegram-show` on the element with `data-rhea-telegram-library`. Dispatch `rhea:telegram-hide` when leaving. The component checks status only while used, clears entered codes and passwords, and removes imported metadata from the view on exit. A late response from an interrupted request cannot repopulate the closed view.

Install the existing [Pages route](../../apps/web/functions/api/rhea/telegram-mtproto.js) at the selected endpoint. Keep the request behind the target workspace's verified Cloudflare Access middleware and exact-origin checks. The same-origin route is the only integration point used by the browser. Follow the [sandbox deployment runbook](07-mtproto-sandbox.md) for the isolated Node host and service authentication. Until that host and bridge are configured, the connection status reports that the reader is unconfigured and the component shows only demonstration data. The existing Bot API connection check runs independently.
