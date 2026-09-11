# Heisenberg Coder Router

Local-only Codex provider/model router for development.

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
- There is no Heisenberg Coder Router login. No application authentication exists; the only authentication involved is the existing Codex/OpenAI login used by the Codex CLI itself.
- A single runtime process serves both the API and the built React dashboard (`npm start`). You do not need to run the Vite frontend separately.

## Ollama

- If Ollama is already installed and running, Heisenberg Coder Router automatically detects it at startup via the standard local Ollama API (`127.0.0.1:11434`).
- Installed Ollama models are automatically discovered and displayed in the model selector.
- The user does not need to manually register Ollama models — model names are never hardcoded; they are read live from your local Ollama instance.
- If Ollama is not running, it is shown as **Offline** and the application keeps working.

## Codex CLI

- The router detects whether Codex CLI is installed and available in PATH and shows its status in the dashboard (**Installed / Not Installed**).
- Starting Codex from the dashboard runs the Codex CLI in the selected project directory:
  - **Ollama provider:** `codex --oss -m <model>` (Codex connects to your local Ollama)
  - **OpenAI provider:** `codex` (Codex uses its existing OpenAI login/configuration)

## Providers

Two providers are supported:

- **Ollama** — local models running on your machine
- **OpenAI** — cloud models via the existing Codex/OpenAI login mechanism

To use OpenAI cloud, switch the provider to **OpenAI** in the dashboard and use the existing Codex/OpenAI login mechanism (`codex login`). Heisenberg Coder Router does not implement its own authentication.

## Dashboard

The single dashboard shows:

- **Server** — `127.0.0.1:7876`
- **Codex** — Installed / Not Installed
- **Ollama** — Online / Offline, with discovered model count
- **Provider** — Ollama / OpenAI selection
- **Model** — models discovered from the selected provider
- **Project** — the project directory Codex runs in
- **Start Codex** / **Stop Codex**

This application is only the local control/router layer. It is not a chat interface and does not recreate Codex.

## External Dependencies

Codex CLI and Ollama remain external dependencies and are **not automatically installed** by this project:

- **Codex CLI:** `npm install -g @openai/codex` — see [github.com/openai/codex](https://github.com/openai/codex)
- **Ollama:** install from [ollama.com](https://ollama.com)

## SQLite

On first startup the application automatically creates `data/router.sqlite` with a minimal schema (settings and a lightweight session log).

## API

- `GET /api/health` — health check
- `GET /api/status` — full system status (Codex, Ollama, providers, project, run state)
- `GET /api/providers` — list providers
- `GET /api/providers/:provider/models` — models for a provider
- `POST /api/providers/active` — set active provider
- `POST /api/providers/model` — set active model
- `GET /api/ollama/status` — Ollama status
- `GET /api/ollama/models` — installed Ollama models
- `POST /api/ollama/refresh` — re-detect Ollama and its models
- `GET /api/codex/status` — Codex CLI status
- `POST /api/codex/start` — start Codex with the selected provider/model/project
- `POST /api/codex/stop` — stop the running Codex process
- `GET /api/project` — current project directory
- `POST /api/project` — set project directory

## Development

- `npm run dev` — build packages and run the API with hot reload (use the Vite dev server in `apps/web` for frontend work)
- `npm run build` — build all packages, the web app, and the API
- `npm start` — run the built application at `http://localhost:7876`
- `npm run typecheck` — typecheck all workspaces

## License

MIT
