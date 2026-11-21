# Persistent Drive and assistant connections in RHEA

Google Drive consent and each assistant grant have separate lifecycles. A legacy
temporary grant remains bounded by its original Google access deadline. A persistent
grant is bound to the Cloudflare Access actor, Google account, Drive link and
registered client. It can renew independently of the browser. The worker exchanges
the saved Google refresh credential when the access token approaches expiration.

## User flow

1. In the workspace, choose **Conectar ao Google Drive** and approve offline access. If a
   legacy temporary session is present, use **Manter o Drive conectado** once.
2. Authorize each desired assistant once. Choose **Autorizar leitura** or, for an
   allowlisted client with a durable link, **Permitir leitura e organização**.
3. Refresh tool discovery in the assistant after a scope change. If
   `rhea_connection_status` reports organization and the tools are absent, check
   the client's catalog and workspace policy.
4. For a synthetic four-file test, call `rhea_organize_files` with destination
   `["Demo","References","Design"]` and the four authorized file IDs.
   Retry a partial result with the same inputs once the underlying error is resolved.
5. Use **Revogar** for one assistant or **Desconectar** for the Drive link and all
   assistant grants. Switching Google accounts revokes grants tied to the previous
   account. Renewing consent for the same linked account preserves valid grants.
   An irrecoverable Google grant requires fresh Drive consent and affected assistant
   reauthorization.

Use the local Gemini CLI `rheaDrive` registration for the remote Drive connector.
Google OAuth application credentials belong in the Pages and Worker environments.

## Runtime setup

- Apply `apps/web/mcp-gateway/0003_drive_links.sql` before enabling persistence. Both
  services need the same D1 database, encryption key, Google OAuth client and
  `RHEA_DRIVE_PERSISTENCE=true`.
- The client allowlist controls `organize: true` eligibility on both services. This
  alone grants no write access. Each user grants organization separately. That
  scope permits creation and movement under the authorized Drive root.
- A short-lived MCP access token is renewed with the assistant's separate refresh
  token. Identical overlapping refresh requests can recover the same rotated
  credentials for 15 seconds. Subsequent replay revokes the grant.
- Check the Google OAuth publishing state if refresh credentials expire repeatedly.
  Use a disposable account and synthetic data for live renewal and revocation tests.

References: [Google offline OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [Google refresh token expiration](https://developers.google.com/identity/protocols/oauth2#expiration), [assistant connections](assistant-connections.md).
