import { createApplication } from './app.mjs';

process.umask(0o077);
const app = await createApplication();
app.server.listen(app.config.port, app.config.host, () => {
  console.log(`Messa listening on ${app.config.host}:${app.server.address().port}`);
  console.log(`Open ${app.config.origin} • ${app.config.production ? 'production' : 'development'}`);
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  const force = setTimeout(() => process.exit(1), 10000); force.unref();
  await app.close(); clearTimeout(force); process.exit(0);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
