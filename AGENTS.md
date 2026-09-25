# Owned Antigravity ACP adapter

This fork supplies subscription-only transport for delegated Pi sessions. Upstream: zacbemis/pi-antigravity-acp-provider. Pi integration and role mappings live in robertvitali/pi and robertvitali/subagents.

- Preserve personal OAuth only. Never add API-key, Vertex, business-auth or paid-credit fallback.
- Pi executes tools. Disable ACP native tools on new/load/resume; accept permissions only for exact registered Pi MCP tools. Do not enable client filesystem or terminal capabilities.
- Keep runtime installation explicit. The Pi integration uses installQualifiedRuntime; qualify each runtime upgrade against authentication, tool boundaries, cancellation and process cleanup before updating its hash. Do not use rolling upstream runtime updates in the fleet integration.
- Gemini is currently delegated only; do not enable it as a main provider or add role mappings here.
- Never persist credentials, raw sessions, machine-specific paths or test output in Git.
- Preserve upstream attribution and license. Keep changes narrow enough to compare against upstream.
- Run npm run check, independently review sensitive changes, then commit. Live authenticated tests are separate and require the subscription-only boundary.
