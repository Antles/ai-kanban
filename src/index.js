import { createApp } from './server.js';

const port = Number(process.env.PORT) || 8080;
const host = process.env.HOST || '0.0.0.0';
const dbPath = process.env.DB_PATH || './data/kanban.db';

const app = createApp({ dbPath, apiKey: process.env.API_KEY || '', directorKey: process.env.DIRECTOR_KEY || '' });

app.server.listen(port, host, () => {
  console.log(`AI Kanban listening on http://localhost:${port}`);
  console.log(`  database: ${dbPath}`);
  console.log(`  auth:     ${process.env.API_KEY ? 'API key required' : 'open (set API_KEY to require a key)'}`);
  console.log(`  director: ${process.env.DIRECTOR_KEY ? 'Director key required' : 'open: any client may act as the Director (set DIRECTOR_KEY)'}`);
});

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    await app.close();
    process.exit(0);
  });
}
