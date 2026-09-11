import { createServer, HOST, PORT } from './server.js';
import { createContext, loadSettings } from './context.js';
import { ensureDataDir } from '@heisenberg/shared';

async function main() {
  // Create data/ and data/router.sqlite on first startup.
  ensureDataDir();

  const context = createContext();

  // Initialize SQLite database.
  context.db.initialize();

  // Restore persisted provider/model/project selections.
  loadSettings(context);

  // Probe Ollama and Codex CLI once at startup.
  await Promise.all([context.ollama.initialize(), context.codex.initialize()]);

  const { app } = await createServer(context);

  try {
    await app.listen({ host: HOST, port: PORT });
  } catch (err) {
    console.error(err);
    process.exit(1);
  }

  console.log('');
  console.log('Heisenberg Coder Router');
  console.log('Running at:');
  console.log('');
  console.log(`http://localhost:${PORT}`);
  console.log('');

  const ollamaOnline = context.ollama.isOnline();
  const codexInstalled = context.codex.isInstalled();
  console.log(`Ollama: ${ollamaOnline ? 'Online' : 'Offline'} | Codex CLI: ${codexInstalled ? 'Installed' : 'Not Installed'}`);
  if (ollamaOnline) {
    const models = await context.ollama.getModels();
    console.log(`Ollama models discovered: ${models.length}`);
  }
  console.log('Press Ctrl+C to stop.');

  const shutdown = async () => {
    try {
      context.codexProcess.stop();
      context.db.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
