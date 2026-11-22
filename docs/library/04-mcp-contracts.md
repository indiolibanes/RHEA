# Library MCP contracts

Proposed Streamable HTTP tools. The current gateway exposes Drive tools. The future Library audience needs explicit, independent, revocable grants. Reuse PKCE, short-lived access tokens, refresh rotation and protected consent patterns. Enforce both tool discovery and call-time authorization. Issue random, actor-bound source, snapshot, plan and run references. Keep titles, filenames, captions, user search text, private Telegram links, inventories, provider IDs and secrets out of model requests and replies.

| Tool | Minimum permission | Input | Output |
| --- | --- | --- | --- |
| `rhea_library_status` | `library:read` | none | Connection status and operation flags. |
| `rhea_library_sources` | `library:read` | bounded cursor | Opaque source references, counts and state. |
| `rhea_library_scan` | `library:plan` | source | Protected scan request link and status. Owner consents to source and scan budget. |
| `rhea_library_catalog` | `library:read` | source, optional A–Z code | Counts, snapshot coverage and private workspace link. |
| `rhea_library_find` | `library:read` | source | Protected search link. The owner enters terms in the workspace. |
| `rhea_library_duplicates` | `library:read` | source | Evidence counts and protected review link. |
| `rhea_library_plan_reflow` | `library:plan` | source, snapshot, strategy, batch size | Dry-run plan reference, counts, blocker codes and protected preview link. |
| `rhea_library_preview_reflow` | `library:read` | plan | Safe summary, expiry and protected preview link. |
| `rhea_library_execution_status` | `library:read` | run | Phase, progress, eligible retry timestamp and safe codes. |
| `rhea_library_cancel` | `library:plan` | run | Cancel a pending plan or request an owner-confirmed safe stop. Active side effects stay in the recovery workflow. |
| `rhea_library_recovery_status` | `library:read` | run | State, reason code, verified coverage and protected recovery link. |

Use separate workspace-only permissions to approve copy and cleanup. No MCP tool can approve either action.

The optional bot companion uses a fixed HTTPS workspace origin, the pinned numeric user ID and a private one-to-one conversation. Check current channel ownership and validate inline callbacks again. Its future webhook must validate the Telegram secret header, deduplicate updates, bound payload size and acknowledge callbacks. Buttons navigate to the protected workspace for all approvals. The tested command router in this branch has no webhook or provider transport.
