# Contributing

Thanks for helping. Three rules keep this project trustworthy:

1. **Clean room.** Implement from specifications (RFC 9110, RFC 8216, ISO/IEC 23009-1, MCP) or from observed server behaviour you are allowed to observe. Never paste decompiled code, extracted resources or proprietary asset from another product.
2. **Evidence.** A parity claim needs a test or a reproducible command. Add the test first when you can.
3. **No new runtime dependencies.** The engine ships zero third-party packages. If you think you need one, open an issue arguing why the stdlib is insufficient.

## Development

```bash
npm test           # 15 engine tests, no network
npm run smoke      # end-to-end CLI + REST + SSE + MCP
npm start          # dashboard on :8420
ODM_DEMO=1 npm start   # adds /demo/seed and /demo/page for UI work
```

State lives in `$ODM_HOME` (default `~/.odm`): `queue.json` plus `jobs/<id>.json`
with the per-segment cursors. Delete the directory to reset the app.

## Adding a capability

1. Put engine logic in `packages/core/src`, exported through `packages/core/src/index.js`.
2. Add a test in `packages/core/test/engine.test.js` that would fail without it.
3. Expose it once in `apps/server/src/server.js` (REST) and once in `apps/server/src/mcp.js` (agent tool).
4. Update `docs/PARITY.md` with the honest status: ✅ / ⚠️ / ❌.

## Style

- 2-space indent, single quotes, semicolons, `node:`-prefixed stdlib imports.
- No classes over 300 lines; split into `#private` helpers instead.
- Errors: throw the typed errors in `src/errors.js`, never bare strings.
- Comments explain *why*; the code says *what*.

## Code of conduct

Be decent. Review the code, not the person. Harassment gets you removed.
