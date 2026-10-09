import { spawn } from 'node:child_process';
import { resolve, sep } from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import type { Recipe } from '@sim/engine';
import { RENDERS_DIR } from '@sim/render';
import { RenderQueue } from './jobs';

const PORT = Number(process.env.SIM_SERVER_PORT ?? 5174);
const app = Fastify({ logger: { level: 'warn' } });
const queue = new RenderQueue();

/** Resolve a path relative to data/renders, refusing anything that escapes it. */
function safeRenderPath(rel: string): string | null {
  const abs = resolve(RENDERS_DIR, rel);
  return abs.startsWith(RENDERS_DIR + sep) ? abs : null;
}

// Rendered files (range requests supported, so <video> can seek).
await app.register(fastifyStatic, { root: RENDERS_DIR, prefix: '/files/', decorateReply: true });

app.post<{ Body: { recipe: Recipe; search?: number } }>('/api/renders', async (req) => {
  const { recipe, search } = req.body;
  return queue.enqueue(recipe, { search: search ? Math.min(5000, Math.max(1, search)) : undefined });
});

app.get('/api/renders', async () => queue.list());

app.get<{ Params: { id: string } }>('/api/renders/:id', async (req, reply) => {
  const job = queue.get(req.params.id);
  return job ?? reply.code(404).send({ error: 'not found' });
});

// Server-sent events: job snapshots until it finishes.
app.get<{ Params: { id: string } }>('/api/renders/:id/stream', (req, reply) => {
  const job = queue.get(req.params.id);
  if (!job) return reply.code(404).send({ error: 'not found' });
  reply.hijack();
  reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (j: typeof job) => {
    reply.raw.write(`data: ${JSON.stringify(j)}\n\n`);
    if (j.status === 'done' || j.status === 'error') {
      unsubscribe();
      reply.raw.end();
    }
  };
  const unsubscribe = queue.subscribe(job.id, send);
  req.raw.on('close', unsubscribe);
  send(job);
});

app.get<{ Querystring: { path: string } }>('/api/download', (req, reply) => {
  const abs = safeRenderPath(req.query.path ?? '');
  if (!abs) return reply.code(400).send({ error: 'bad path' });
  const rel = abs.slice(RENDERS_DIR.length + 1);
  const name = rel.split(sep).slice(-2).join('-');
  return reply.download(rel, name);
});

// Local-only convenience: reveal a render in Finder.
app.post<{ Body: { path: string } }>('/api/reveal', async (req, reply) => {
  const abs = safeRenderPath(req.body.path ?? '');
  if (!abs) return reply.code(400).send({ error: 'bad path' });
  spawn('open', ['-R', abs], { stdio: 'ignore' }).unref();
  return { ok: true };
});

const shutdown = async () => {
  await queue.close();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: PORT, host: '127.0.0.1' });
console.log(`Sim server on http://127.0.0.1:${PORT}`);
