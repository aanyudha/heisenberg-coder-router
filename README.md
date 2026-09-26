# Heisenberg Coder Router

Heisenberg Coder Router (HCR) is a local routing control plane for Codex, plus a
review-first Web Handoff workflow that lets ChatGPT Web propose patches to your
project.

Choose the provider and model once in HCR, apply the route, then use Codex
normally from the CLI or a VS Code Codex integration that shares the same Codex
configuration. Separately, hand a bounded slice of your project to ChatGPT Web
through the optional Browser Companion and apply the returned patch only after
you review the diff.

```
                        HCR  (127.0.0.1:7876)
        +-------------------+----------------------+
        |                   |                      |
   Routing control     Ollama gateway        Web Handoff
   (Codex config,      (live telemetry,      (context -> ChatGPT Web ->
    drift, verify)       no content)           HCR_PATCH_V1 -> review)
        |                   |                      |
   Codex CLI / VS         Ollama             Browser Companion
   Code Codex           127.0.0.1:11434      (optional extension)
```

HCR does not launch Codex for you. There is no Start/Stop Codex, no background
process, and no chat interface inside HCR. HCR manages routing, not Codex
conversations.

## Control Plane and Data Plane

**Control plane**

- provider/model selection
- Codex configuration
- route verification
- drift detection

**Data plane - currently Ollama only**

- transparent inference forwarding
- streaming
- live route verification
- truthful telemetry

```
Codex CLI / VS Code
        |
        v
HCR gateway   127.0.0.1:7876/gateway/ollama/v1
        |
        v
Ollama        127.0.0.1:11434/v1
        |
        v
Local Model
```

For the Ollama route, HCR writes the HCR gateway address
(`http://127.0.0.1:7876/gateway/ollama/v1`) into the Codex configuration as the
provider `base_url`. Codex inference traffic for Ollama therefore flows through
HCR, which transparently forwards it to the real Ollama upstream
(`http://127.0.0.1:11434/v1`) while observing request metadata only. Because HCR
sits in the data path, Ollama inference traffic routed through HCR **can be
observed live**: the dashboard shows IDLE -> GENERATING during a request, and
token usage, latency, and throughput are reported when Ollama reliably provides
them.

### Context window (`model_context_window`)

Codex does not know the context window of custom-provider models and falls back to a small built-in default. Ollama, meanwhile, rejects requests whose token count exceeds the model's effective `num_ctx` (default **4096**) with:

```
request (N tokens) exceeds the available context size (4096 tokens), try increasing it
```

When you apply an Ollama route, HCR queries the live Ollama instance (`/api/ps` while the model is loaded, otherwise `/api/show`) and writes the observed context window into the Codex configuration as `model_context_window`. This makes Codex plan against the real budget instead of its default. If the value cannot be observed, HCR writes nothing rather than guessing; raise Ollama's `num_ctx` (e.g. `OLLAMA_CONTEXT_LENGTH` or a `num_ctx` Modelfile parameter) and reapply the route to pick up the larger window.

OpenAI remains **control-plane routing only**: HCR writes/normalizes the OpenAI
route in the Codex configuration, but OpenAI inference traffic is not proxied or
monitored by HCR.

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

Open `http://127.0.0.1:7876` to access the dashboard.

## Dashboard

The dashboard is a dark, office-style admin app with a permanent (collapsible)
left sidebar and 12 pages:

| Section | Pages |
| --- | --- |
| - | Overview |
| AI Routing | Routing, Providers, Models |
| Automation | Web Handoff, Browser Companion |
| Workspace | Projects, Activity |
| Monitoring | Live Traffic, Telemetry |
| System | Settings, About |

Routing shows the desired route, the applied Codex route, layered verification
(config / runtime / observed traffic) and a drift banner with **Reapply HCR
Route**. Monitoring pages only display metrics HCR actually observed - unknown
values render as unknown, never as zero.

## Server

- **Default server:** `127.0.0.1:7876` - localhost-only, never `0.0.0.0`.
- There is no HCR login. The companion endpoints are protected by a local
  pairing token instead (see Browser Companion below).
- A single runtime process serves both the API and the built React dashboard
  (`npm start`).

## How Routing Works

HCR stores your desired route (provider + model + project directory) in
`data/router.sqlite` and writes that route into the standard Codex
configuration file (`~/.codex/config.toml`, honoring `CODEX_HOME`). After the
route is applied, a normal `codex` invocation resolves to the HCR-selected
provider/model.

The dashboard distinguishes the **HCR desired route** from the **applied Codex
route** and reports drift when they differ. Applying routing never overwrites
unrelated Codex settings: HCR only mutates the settings it owns and preserves
other keys, sections and comments. A one-time backup (`config.toml.hcr-backup`)
is created before HCR first modifies an existing Codex config.

## Workflow - Ollama

1. Run Ollama.
2. HCR detects installed Ollama models automatically.
3. Select Ollama.
4. Select a model.
5. Click **Apply Routing**.
6. Run Codex normally (`codex`).

If Ollama is offline, applying the Ollama route fails with a clear error. Ollama
models are discovered live from your local Ollama instance and are never
hardcoded.

## Workflow - OpenAI / Codex Cloud

1. Ensure Codex CLI is authenticated with OpenAI using its normal login
   (`codex login`).
2. Select OpenAI in HCR.
3. Click **Apply Routing**.
4. Use Codex normally.

Applying the OpenAI route removes Ollama routing state from the Codex
configuration, so no stale local-provider setting leaks into the cloud route.
HCR does not implement OpenAI authentication and never stores OpenAI
credentials.

## Web Handoff (ChatGPT Web)

Web Handoff lets ChatGPT Web act as the planning/code-generation intelligence
while HCR keeps control of the filesystem. Codex is not involved, and no OpenAI
API credentials are used.

The workflow is deliberately two-step:

1. **Prepare** - `POST /api/web-handoff` builds a bounded project context
   (relevant files only) and returns it for review. **Nothing is sent to
   ChatGPT yet.**
2. **Review the context** - the dashboard shows how many files and how many
   bytes would be transmitted, plus everything excluded (and why).
3. **Send** - `POST /api/web-handoff/:id/send` queues the prompt for the
   Browser Companion, which types it into your own ChatGPT tab.
4. **Validate** - the reply must be a valid `HCR_PATCH_V1` JSON document and
   every path must pass workspace validation. Prose, markdown-only answers,
   wrong versions, unknown actions, absolute paths, `..`, system directories,
   reserved device names, protected files and symlink escapes are rejected.
5. **Review the diff** - proposed `create` / `replace` / `delete` changes are
   shown as a unified diff against the current files on disk.
6. **Apply / Revert** - applying writes atomically (temp file + rename) after
   re-validating the patch, keeps a snapshot for one-level rollback, and can be
   reverted from the dashboard.

If the response fails validation the handoff moves to
`invalid_patch_response`; nothing is written, the raw response can be inspected,
and **Retry with Correction Prompt** resends a strict format reminder.

`HCR_PATCH_V1` shape:

```json
{
  "version": "HCR_PATCH_V1",
  "summary": "one line description",
  "files": [
    { "path": "relative/path.ts", "action": "create", "content": "full file content" },
    { "path": "relative/other.ts", "action": "replace", "content": "full file content" },
    { "path": "relative/old.ts", "action": "delete" }
  ]
}
```

Handoff states:
`context_ready` -> `waiting_for_browser` -> `opening_chatgpt` ->
`sending_prompt` -> `waiting_for_response` -> `receiving_response` ->
`validating_patch` -> `ready_for_review` -> (`applied` | `reverted` |
`rejected` | `invalid_patch_response` | `error`).

## Browser Companion (optional)

The Browser Companion is a Manifest V3 Chrome/Edge extension that carries the
prepared prompt into your own ChatGPT tab and returns the reply to HCR. Without
it, handoffs simply stay queued.

```bash
npm run build:companion
```

produces `apps/browser-companion/hcr-browser-companion.zip` (also downloadable
from the dashboard at `/downloads/hcr-browser-companion.zip`).

Setup:

1. Extract the zip to a folder.
2. Open `chrome://extensions` (or `edge://extensions`), enable **Developer
   mode**, click **Load unpacked**, select the folder.
3. In the dashboard open **Browser Companion**, click **Generate Pairing Code**.
4. Paste the code into the extension popup.
5. Keep a `https://chatgpt.com` tab open and signed in.

Pairing and security:

- HCR generates a random 32-byte pairing secret, stored only in local SQLite.
- The pairing code is 8 characters, single-use, valid for 10 minutes.
- The extension exchanges the code once and stores the secret locally; the
  secret is sent only to `127.0.0.1`, never to chatgpt.com or any remote host.
- Every companion control endpoint (`heartbeat`, `task`, `stage`, `result`)
  requires the `x-hcr-companion-token` header and is compared in constant time;
  unauthorized requests get `401`.
- Only `https://chatgpt.com/*` tabs are ever targeted. HCR never reads or stores
  cookies, credentials or session storage, never logs in for you, and never
  solves CAPTCHAs - if ChatGPT needs sign-in, the handoff reports
  `AUTH_REQUIRED` with "Open ChatGPT and sign in, then retry."
- **Rotate Secret** invalidates the old token so the extension must pair again.

## Context Privacy

What actually leaves your machine is decided locally, before anything is sent:

- **Prepare is local only.** `POST /api/web-handoff` reads files from disk and
  builds the context in process memory. Nothing is transmitted until you press
  **Send**.
- **Bounded by construction.** Context is capped at 40 files, 64 KB per file,
  256 KB in total and a 400-entry file tree (depth 12). Files beyond a limit are
  excluded with the reason shown in review, never silently truncated into the
  prompt.
- **Excluded before ranking.** Secret files, `.git/*`, `.gitignore`d paths,
  dependency/build/output directories, binaries, lockfiles, generated and
  minified artifacts, unreadable files and paths past the depth limit are never
  read into the context; every exclusion is listed with its reason.
- **Only included files are sent.** The prompt carries the task, the project
  name, the bounded file tree and the contents of the included files - and it
  goes only to your own ChatGPT tab through the local Browser Companion.
- **Nothing is persisted except review metadata.** The prepared context and raw
  ChatGPT responses stay in process memory. SQLite stores only handoff metadata
  (task title, status, timestamps) plus the validated patch JSON (local-only,
  capped at 1 MB) needed for review, apply and revert.
- **Restart clears it.** Because context and raw responses are in-memory, they
  are gone when HCR restarts; only the local patch needed for revert survives.

## Privacy and Safety Guarantees

- No shell commands are ever generated from a model response.
- No git commit, push, branch or tag operation is performed automatically.
- No OpenAI API key is used, requested or stored for Web Handoff.
- No ChatGPT credentials, cookies or CAPTCHA automation.
- Only `https://chatgpt.com/*` is an allowed browser target.
- Patches are never auto-applied: review first, then apply, then revert.
- Secret files (`.env*`, `*.pem`, `*.key`, `id_*`, `.npmrc`, `.netrc`,
  `credentials*`, `secrets.*`, `.ssh/*`), `.git/*`, dependency directories,
  lockfiles and binaries are excluded from context and protected from writes.
- Gateway telemetry is metadata-only and kept in a bounded in-memory buffer;
  HCR never stores prompt contents, generated responses, or conversation
  history.

## Route Verification

Verification is layered and truthful:

- **Codex Config** - `HCR Route Configured` only when the Codex config points at
  the HCR gateway route.
- **Runtime** - Ollama online with the selected model discovered (or Codex
  installed for the OpenAI route).
- **Live Traffic** - `HCR ROUTE VERIFIED` only after a real inference request
  passed through the HCR gateway.

Telemetry with no reliable source reports `null` (displayed as unknown), never a
fake zero:

```
GET /api/telemetry
```

Once Ollama traffic flows through the gateway, `source` becomes `hcr-gateway`
and request state, latency, time-to-first-byte, request count, and (when Ollama
returns usage metadata) token counts are reported truthfully.

```
GET /api/telemetry/recent   # metadata only, bounded ring buffer
```

## API

Routing and system:

- `GET /api/health` - health check
- `GET /api/status` - full system status (Codex, Ollama, providers, routing, project)
- `GET /api/routing` - desired vs applied route and routing status
- `POST /api/routing/apply` - apply the desired provider/model route to Codex configuration
- `GET /api/routing/verify` - drift, config validity, layered verification, VS Code Codex detection
- `GET /api/telemetry` - truthful telemetry snapshot
- `GET /api/telemetry/recent` - recent gateway request metadata (no content)
- `GET /api/providers` - list providers
- `GET /api/providers/:provider/models` - models for a provider
- `POST /api/providers/active` - set active provider (desired state)
- `POST /api/providers/model` - set active model (desired state)
- `GET /api/ollama/status`, `GET /api/ollama/models`, `POST /api/ollama/refresh`
- `GET /api/codex/status`
- `GET /api/project`, `POST /api/project`

Web Handoff:

- `POST /api/web-handoff` - prepare context (nothing is sent)
- `GET /api/web-handoff?limit=N` - recent handoff summaries
- `GET /api/web-handoff/:id` - handoff detail (files, diffs, status)
- `GET /api/web-handoff/:id/context` - full context + exclusions
- `POST /api/web-handoff/:id/send` - queue the prompt for the companion
- `POST /api/web-handoff/:id/retry` - requeue with the correction prompt
- `POST /api/web-handoff/:id/reject` - reject the proposal
- `POST /api/web-handoff/:id/apply` - validate and write the reviewed patch
- `POST /api/web-handoff/:id/revert` - one-level rollback of the last apply

Browser Companion:

- `GET /api/browser-companion/status` - connection, pairing and ChatGPT state
- `POST /api/browser-companion/pairing-code` - short-lived single-use code
- `POST /api/browser-companion/pair` - exchange code for the local token
- `POST /api/browser-companion/reset` - rotate the pairing secret
- `POST /api/browser-companion/test` - connection test
- `POST /api/browser-companion/heartbeat` - token required
- `GET /api/browser-companion/task` - token required
- `POST /api/browser-companion/task/:id/stage` - token required
- `POST /api/browser-companion/task/:id/result` - token required
- `GET /api/browser-companion/download`, `GET /downloads/hcr-browser-companion.zip`

## External Dependencies

Codex CLI and Ollama remain external dependencies and are **not automatically
installed**:

- **Codex CLI:** `npm install -g @openai/codex` - see
  [github.com/openai/codex](https://github.com/openai/codex)
- **Ollama:** install from [ollama.com](https://ollama.com)

## Storage

On first startup HCR creates `data/router.sqlite` containing the desired route,
project directory, companion pairing state and Web Handoff metadata (task title,
status, and the local-only patch needed for review/revert). No cookies, no
credentials, no project context and no conversation history are stored. Set
`HCR_DATA_DIR` to relocate the database (used by the test suite).

## Development

- `npm run dev` - build packages and run the API with hot reload (use the Vite
  dev server in `apps/web` for frontend work)
- `npm run build` - build all packages, the web app, the API and the companion
  extension
- `npm run build:companion` - build only the browser extension zip
- `npm start` - run the built application at `http://127.0.0.1:7876`
- `npm run typecheck` - typecheck all workspaces (including the extension)
- `npm test` - build everything, then run the node test suites in `tests/`

Test suites cover patch schema validation, workspace path safety (traversal,
absolute paths, protected files, symlink escapes), apply/revert/rollback
behaviour, companion pairing and token authorization, context exclusion
secrets/lockfiles/binaries and the full Web Handoff lifecycle.

## License

MIT
