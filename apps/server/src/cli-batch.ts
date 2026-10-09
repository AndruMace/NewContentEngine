/**
 * Start a batch from the terminal. Uses the running server if there is one (so the UI sees it),
 * otherwise runs the batch in-process.
 *
 *   npm run batch                         # settings from the UI (last used)
 *   npm run batch -- --posts 2 --factor 2 --templates ring-escape,marble-race --min 20 --max 35
 *   npm run batch -- --dry                # offline: mock planner instead of Claude
 */
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { ROOT } from '@sim/render';

try {
  process.loadEnvFile(join(ROOT, '.env'));
} catch {
  /* no .env */
}

const { values: a } = parseArgs({
  options: {
    posts: { type: 'string' },
    factor: { type: 'string' },
    templates: { type: 'string' },
    themes: { type: 'string' },
    min: { type: 'string' },
    max: { type: 'string' },
    notes: { type: 'string' },
    'no-claude': { type: 'boolean' },
    dry: { type: 'boolean' },
  },
});

const settings: Record<string, unknown> = {};
if (a.posts) settings.postsWanted = Number(a.posts);
if (a.factor) settings.factor = Number(a.factor);
if (a.templates) settings.templateIds = a.templates.split(',');
if (a.themes) settings.themeIds = a.themes.split(',');
if (a.min) settings.minLengthS = Number(a.min);
if (a.max) settings.maxLengthS = Number(a.max);
if (a.notes) settings.notes = a.notes;
if (a['no-claude']) settings.useClaude = false;
if (a.dry) settings.notifyMac = false;

const API = `http://127.0.0.1:${process.env.SIM_SERVER_PORT ?? 5174}`;

type Snapshot = { batch: { id: string; status: string; warnings: string[] }; planned: number; items: { status: string; recipe: { templateId: string }; copy: { hook: string } | null; qc: { pass: boolean } | null; score: number | null }[]; eta: number | null };

let lastLine = '';
function report(s: Snapshot) {
  const c = s.items.reduce<Record<string, number>>((m, i) => ((m[i.status] = (m[i.status] ?? 0) + 1), m), {});
  const line = `[${s.batch.status}] planned ${s.planned} · ready ${c.ready ?? 0} · rendering ${c.rendering ?? 0} · queued ${c.queued ?? 0} · failed ${c.failed ?? 0}${s.eta ? ` · ~${Math.ceil(s.eta / 60)} min left` : ''}`;
  if (line !== lastLine) console.log((lastLine = line));
}

function summary(s: Snapshot) {
  console.log(`\nBatch ${s.batch.id} ${s.batch.status}.`);
  for (const w of s.batch.warnings) console.log(`  ! ${w}`);
  s.items.forEach((i, n) =>
    console.log(`  ${n + 1}. ${i.recipe.templateId.padEnd(16)} ${i.status.padEnd(9)} ${i.qc ? (i.qc.pass ? 'QC ok ' : 'QC FAIL') : '       '} drama ${Math.round((i.score ?? 0) * 100)
      .toString()
      .padStart(3)}  "${i.copy?.hook ?? ''}"`),
  );
  console.log('\nReview them in the UI: npm run dev → Batches & Review');
}

async function viaServer(): Promise<boolean> {
  try {
    await fetch(`${API}/api/status`, { signal: AbortSignal.timeout(800) });
  } catch {
    return false;
  }
  if (a.dry) {
    console.error('--dry needs the server stopped (the mock planner runs in-process).');
    process.exit(1);
  }
  const res = await fetch(`${API}/api/batches`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ settings }) });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error);
  console.log(`Started batch ${body.id} on the running server.`);
  for (;;) {
    const s: Snapshot = await (await fetch(`${API}/api/batches/${body.id}`)).json();
    report(s);
    if (['done', 'cancelled', 'failed'].includes(s.batch.status)) return summary(s), true;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function inProcess() {
  if (a.dry) process.env.SIM_PLANNER = 'mock';
  const { DEFAULT_BATCH_SETTINGS, getKv } = await import('./db');
  const { RenderScheduler } = await import('./scheduler');
  const { SearchPool } = await import('./searchPool');
  const { BatchRunner } = await import('./batch');
  const { batchSnapshot } = await import('./views');
  const scheduler = new RenderScheduler();
  const pool = new SearchPool();
  const runner = new BatchRunner(scheduler, pool);
  scheduler.start();
  const batch = runner.start({ ...DEFAULT_BATCH_SETTINGS, ...getKv('batchSettings', {}), ...settings } as never);
  console.log(`Started batch ${batch.id} in-process${a.dry ? ' (dry run: mock planner)' : ''}.`);
  runner.on('changed', (id: string) => id === batch.id && report(batchSnapshot(id, runner.eta(id)) as Snapshot));
  await new Promise<void>((resolve) => runner.on('finished', (id: string) => id === batch.id && resolve()));
  summary(batchSnapshot(batch.id, null) as Snapshot);
  await scheduler.stop();
  await pool.close();
}

if (!(await viaServer())) await inProcess();
process.exit(0);
