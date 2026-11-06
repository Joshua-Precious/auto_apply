import { PostgresAdapter, defaultSecurity } from 'cequre-ts';
import { createCequre } from './_generated/server';
import { routesModule } from './routes';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

export const app = createCequre({
  adapter: new PostgresAdapter(databaseUrl, 10, false),
  plugins: [defaultSecurity()],
}).use(routesModule);

export default app;
