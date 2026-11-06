import { app } from '../cequre/app';

// Initialize through the same runtime path the API uses. The Cequre CLI
// db:sync command can report changes without applying them to an existing DB.
try {
  await app.init();
  console.log('Cequre schema ready.');
} finally {
  app.retire();
  await app.adapter.disconnect();
}