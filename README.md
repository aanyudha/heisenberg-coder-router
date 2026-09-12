# Heisenberg Coder Router

Heisenberg Coder Router (HCR) is a local routing control plane for Codex.

Choose the provider and model once in HCR, apply the route, then use Codex normally from the CLI or a VS Code Codex integration that uses the same Codex configuration.

```
                       HCR
              http://localhost:7876
                       │
                       ▼
                Provider + Model
                       │
                       ▼
               Codex Configuration
                       │
            ┌──────────┴──────────┐
            ▼                     ▼
       Codex CLI             VS Code Codex
            │                     │
            └──────────┬──────────┘
                       ▼
                  Same Route
```

HCR does not launch Codex for you. There is no Start/Stop Codex, no background process, and no chat interface. HCR manages routing, not Codex conversations.

## Control Plane and Data Plane

HCR now has two responsibilities:

**Control plane**

- provider/model selection
- Codex configuration
- route verification
- drift detection

**Data plane — currently Ollama only**

- transparent inference forwarding
- streaming
- live route verification
- truthful telemetry

```
Codex CLI / VS Code
        │
        ▼
HCR
127.0.0.1:7876
        │
        ▼
Ollama
127.0.0.1:11434
        │
        ▼
Local Model
```

For the Ollama route, HCR writes the HCR gateway address (`http://127.0.0.1:7876/gateway/ollama/v1`) into the Codex configuration as the provider `base_url`. Codex inference traffic for Ollama therefore flows through HCR, which transparently forwards it to the real Ollama upstream (`http://127.0.0.1:11434/v1`) while observing request metadata only. Because HCR sits in the data path, Ollama inference traffic routed through HCR **can now be observed live**: the dashboard shows IDLE → GENERATING during a request, and token usage, latency, and throughput are reported when Ollama reliably provides them.

OpenAI remains **control-plane routing only** in this phase: HCR writes/normalizes the OpenAI route in the Codex configuration, but OpenAI inference traffic is not proxied or monitored by HCR.

## Installation

```bash
git clone https://github.com/USERNAME/heisenberg-coder-router.git

cd heisenberg-coder-router

npm install

npm run build

npm start
```

After starting, the console shows:

```
Heisenberg Coder Router
Running at:

http://localhost:7876
```

Open your browser and navigate to `http://localhost:7876` to access the dashboard.

## Server

- **Default server:** `127.0.0.1:7876`
- The server is localhost-only by default — it does not listen on `0.0.0.0` and is not reachable from your LAN.
- There is no Heisenberg Coder Router login. No application authentication exists.
- A single runtime process serves both the API and the built React dashboard (`npm start`). You do not need to run the Vite frontend separately.

## How Routing Works

HCR stores your desired route (provider + model + project directory) in `data/router.sqlite` and writes that route into the standard Codex configuration file (`~/.codex/config.toml`, honoring `CODEX_HOME`). After the route is applied, a normal `codex` invocation resolves to the HCR-selected provider/model — from PowerShell, Windows Terminal, the VS Code integrated terminal, or a VS Code Codex integration that shares the same Codex configuration.

The dashboard distinguishes the **HCR desired route** from the **applied Codex route** and reports drift when they differ, with a **Reapply HCR Route** button. Applying routing never overwrites unrelated Codex settings, and a one-time backup (`config.toml.hcr-backup`) is created before HCR first modifies an existing Codex config.

## Workflow — Ollama

1. Run Ollama.
2. HCR detects installed Ollama models automatically.
3. Select Ollama.
4. Select a model.
5. Click **Apply Routing**.
6. Run Codex normally (`codex`).

If Ollama is offline, applying the Ollama route fails with a clear error. Ollama models are discovered live from your local Ollama instance and are never hardcoded.

## Workflow — OpenAI / Codex Cloud

1. Ensure Codex CLI is authenticated with OpenAI using its normal login (`codex login`).
2. Select OpenAI in HCR.
3. Click **Apply Routing**.
4. Use Codex normally.

Applying the OpenAI route removes Ollama routing state from the Codex configuration, so no stale local-provider setting leaks into the cloud route. HCR does not implement OpenAI authentication and never stores OpenAI credentials.

## Providers

Two providers are supported:

- **Ollama** — local models running on your machine
- **OpenAI** — cloud models via the existing Codex/OpenAI login mechanism

## Dashboard & Telemetry

HCR provides a cockpit-style dashboard for monitoring:

- active provider
- active model
- routing status (Applied / Drift / Not Configured / Error)
- Codex availability
- Ollama availability
- live gateway traffic (IDLE / GENERATING) for the Ollama data plane
- routing drift (with a **Reapply HCR Route** action)
- telemetry where available

Route verification is layered and truthful:

- **Codex Config** — `HCR Route Configured` only when the Codex config points at the HCR gateway route.
- **Runtime** — Ollama online with the selected model discovered (or Codex installed for the OpenAI route).
- **Live Traffic** — `HCR ROUTE VERIFIED` only after a real inference request has passed through the HCR gateway. Before that, wording stays at `Route configured — runtime not yet observed`.

"HCR currently acts primarily as a routing control plane. Token usage, latency, throughput, and context utilization are shown only when HCR has a reliable telemetry source. Unknown metrics are displayed as unavailable rather than estimated."

The dashboard exposes telemetry state via:

```
GET /api/telemetry
```

Example response while HCR has no inference telemetry source:

```json
{
  "source": "unavailable",
  "provider": "ollama",
  "model": "qwen3-coder:30b",
  "inputTokens": null,
  "outputTokens": null,
  "totalTokens": null,
  "contextUsed": null,
  "contextLimit": null,
  "requestCount": null,
  "latencyMs": null,
  "averageLatencyMs": null,
  "tokensPerSecond": null,
  "uptimeSeconds": 42,
  "observedAt": "2026-09-12T00:00:00.000Z"
}
```

Unknown metrics are `null` — never fake zeros. When no gateway traffic has been observed, only HCR server uptime is real. Once Ollama traffic flows through the HCR gateway, `source` becomes `hcr-gateway` and request state, latency, time-to-first-byte, request count, and (when Ollama returns usage metadata) token counts are reported truthfully.

Recent gateway request metadata (request id, provider, model, duration, status, token counts — never prompt or response content) is available at:

```
GET /api/telemetry/recent
```

Privacy: HCR never stores prompt contents, generated response text, source code sent to models, or conversation history. Gateway telemetry is metadata-only and kept in a bounded in-memory buffer; nothing is persisted to SQLite.

## External Dependencies

Codex CLI and Ollama remain external dependencies and are **not automatically installed** by this project:

- **Codex CLI:** `npm install -g @openai/codex` — see [github.com/openai/codex](https://github.com/openai/codex)
- **Ollama:** install from [ollama.com](https://ollama.com)

## SQLite

On first startup the application automatically creates `data/router.sqlite` with the HCR desired route (selected provider, selected model, project directory). The database is resolved from the repository root regardless of the directory `npm start` is executed from.

## API

- `GET /api/health` — health check
- `GET /api/status` — full system status (Codex, Ollama, providers, routing, project)
- `GET /api/routing` — desired vs applied route and routing status
- `POST /api/routing/apply` — apply the desired provider/model route to Codex configuration
- `GET /api/routing/verify` — verify routing (drift, config validity, VS Code Codex detection)
- `GET /api/telemetry` — truthful telemetry snapshot (nulls for unobserved metrics; live gateway state when traffic flows)
- `GET /api/telemetry/recent` — recent gateway request metadata (no content)
- `GET /api/providers` — list providers
- `GET /api/providers/:provider/models` — models for a provider
- `POST /api/providers/active` — set active provider (desired state)
- `POST /api/providers/model` — set active model (desired state)
- `GET /api/ollama/status` — Ollama status
- `GET /api/ollama/models` — installed Ollama models
- `POST /api/ollama/refresh` — re-detect Ollama and its models
- `GET /api/codex/status` — Codex CLI detection status
- `GET /api/project` — current project directory
- `POST /api/project` — set project directory

## Development

- `npm run dev` — build packages and run the API with hot reload (use the Vite dev server in `apps/web` for frontend work)
- `npm run build` — build all packages, the web app, and the API
- `npm start` — run the built application at `http://localhost:7876`
- `npm run typecheck` — typecheck all workspaces

## License

MIT
