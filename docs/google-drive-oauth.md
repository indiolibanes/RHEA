# Web and Google Drive setup

Use an HTTPS hostname protected by Cloudflare Access. Set the Cloudflare Pages project root to `apps/web`, its build command to `npm run build`, and its output directory to `dist`. The project also contains Pages Functions under `functions/`.

## Google OAuth

1. Create a Google Cloud project for the instance and enable the Google Drive API.
2. Configure the consent screen for the intended users and add the `https://www.googleapis.com/auth/drive.file` scope. For a testing application, add the accounts that will connect.
3. Create a **Web application** OAuth client. Register the exact callback on your Pages hostname, for example `https://workspace.example.com/api/rhea/callback`.
4. Configure the Pages environment using the table below. Store credentials as secrets. Keep the Access audience and deployment branch aligned with the environment serving the site.

| Setting | Value |
| --- | --- |
| `RHEA_PUBLIC_ORIGIN` | Exact HTTPS origin, without a trailing slash. |
| `RHEA_PRODUCTION_BRANCH` | Branch allowed to serve the API. |
| `CF_PAGES_BRANCH` or `RHEA_RUNTIME_BRANCH` | Effective branch available to Functions. |
| `ACCESS_TEAM_DOMAIN` | Your team's Cloudflare Access domain. |
| `ACCESS_AUD` or `RHEA_ACCESS_AUD` | Audience of the Access application protecting the workspace. |
| `RHEA_GOOGLE_CLIENT_ID` | Google OAuth web client ID. |
| `RHEA_GOOGLE_CLIENT_SECRET` | Google OAuth web client secret. |
| `RHEA_COOKIE_KEY` | Independently generated strong base64url secret, 43–128 characters. |

## Check the connection

Open the workspace and choose **Conectar ao Google Drive**. Complete consent in the same browser tab. Choose **Testar conexão** to verify list access under the app-created RHEA folder. Add a synthetic test file to verify uploads and the explorer.

For durable Drive consent and connected assistants, configure [persistent connections](persistent-connections.md) and the [MCP gateway](mcp-gateway.md).

[Cloudflare Pages bindings](https://developers.cloudflare.com/pages/functions/bindings/) · [Google OAuth web applications](https://developers.google.com/identity/protocols/oauth2/web-server)
