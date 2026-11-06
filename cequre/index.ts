import { app } from './app';

const port = Number(process.env.PORT || process.env.SERVICE_PORT || 4310);
const hostname = process.env.HOST || '127.0.0.1';

if (process.env.SCHEMA_INIT_ONLY === '1') {
  try {
    await app.init();
    console.log('Cequre schema ready.');
  } finally {
    app.retire();
    await app.adapter.disconnect();
  }
} else {
  app.start({ port, hostname }).catch((error: unknown) => {
    console.error(JSON.stringify({ level: 'error', message: 'Cequre server failed to start', error: String(error) }));
    process.exitCode = 1;
  });
}
