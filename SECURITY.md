# Security

## Credentials

- The MOSS API key is stored **only on the DSH host**, in
  `~/.dsh/moss-live.key` (written with mode `0600`) or in a file named by
  `config.apiKeyFile`, or supplied through the `MOSS_API_KEY` environment
  variable.
- The browser never receives the key. The key endpoint returns a mask only
  (`••••abcd` + source), and neither logs nor session storage contain it.
- State written by the plugin stays local: `~/.dsh/moss-live/history.jsonl`
  (transcripts) and the configured debug log.

## Local endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET/POST /moss-live/key` | DSH browser cookie (`ctx.connection.requestRejection`) | key status / save / clear |
| `GET/DELETE /moss-live/history` | same | transcript history |
| `WebSocket /moss-live/v1` | same | voice carrier |

All of them refuse requests without a valid DSH browser session (`401`).

## Reporting

Please open an issue without attaching keys, transcripts, or any `~/.dsh`
contents. If a leak is suspected, rotate the MOSS API key first.
