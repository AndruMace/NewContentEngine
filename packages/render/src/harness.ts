import { createServer, type Server } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright-core';
import type { Recipe } from '@sim/engine';
import type { RenderPageOptions, RenderPageResult } from './page/main';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ROOT = resolve(here, '../../..');
const CACHE = join(ROOT, '.render-cache');

let bundlePromise: Promise<string> | null = null;

/** Bundle the render page (engine + templates + audio) into one JS file. */
function bundlePage(): Promise<string> {
  bundlePromise ??= (async () => {
    await mkdir(CACHE, { recursive: true });
    const outfile = join(CACHE, 'render-page.js');
    await build({
      entryPoints: [join(here, 'page/main.ts')],
      bundle: true,
      format: 'esm',
      target: 'chrome120',
      outfile,
      logLevel: 'warning',
    });
    return readFile(outfile, 'utf8');
  })();
  return bundlePromise;
}

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#000}canvas{display:none}</style></head>
<body><script type="module" src="render-page.js"></script></body></html>`;

interface Job {
  outDir: string;
}

/**
 * Local HTTP server + headless Chrome. One instance can render many recipes; each
 * render gets its own page. Uploads from the page land in that job's outDir.
 */
export class RenderHarness {
  private server: Server | null = null;
  private browser: Browser | null = null;
  private port = 0;
  private jobs = new Map<string, Job>();

  async start() {
    const js = await bundlePage();
    const font = await readFile(require.resolve('@fontsource/montserrat/files/montserrat-latin-900-normal.woff2'));
    this.server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const jobId = url.pathname.split('/')[1];
      const job = this.jobs.get(jobId);
      const path = '/' + url.pathname.split('/').slice(2).join('/');
      if (!job) {
        res.writeHead(404).end();
        return;
      }
      if (path === '/' || path === '/index.html') res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE_HTML);
      else if (path === '/render-page.js') res.writeHead(200, { 'content-type': 'text/javascript' }).end(js);
      else if (path === '/fonts/montserrat-900.woff2') res.writeHead(200, { 'content-type': 'font/woff2' }).end(font);
      else if (path === '/upload' && req.method === 'POST') {
        const name = url.searchParams.get('name') ?? '';
        if (!/^[\w.-]+$/.test(name)) {
          res.writeHead(400).end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        await writeFile(join(job.outDir, name), Buffer.concat(chunks));
        res.writeHead(200).end('ok');
      } else res.writeHead(404).end();
    });
    await new Promise<void>((ok) => this.server!.listen(0, '127.0.0.1', ok));
    const addr = this.server.address();
    this.port = typeof addr === 'object' && addr ? addr.port : 0;
    this.browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      args: ['--autoplay-policy=no-user-gesture-required', '--enable-gpu-rasterization', '--ignore-gpu-blocklist'],
    });
  }

  async render(
    recipe: Recipe,
    outDir: string,
    opts: Partial<RenderPageOptions> & {
      onProgress?: (frame: number, est: number) => void;
      onStage?: (stage: string) => void;
    } = {},
  ): Promise<RenderPageResult> {
    if (!this.browser) throw new Error('RenderHarness not started');
    await mkdir(outDir, { recursive: true });
    const jobId = Math.random().toString(36).slice(2);
    this.jobs.set(jobId, { outDir });
    const page = await this.browser.newPage({ viewport: { width: 400, height: 400 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    try {
      await page.exposeFunction('reportProgress', (f: number, est: number) => opts.onProgress?.(f, est));
      await page.exposeFunction('reportStage', (stage: string) => opts.onStage?.(stage));
      await page.goto(`http://127.0.0.1:${this.port}/${jobId}/`);
      await page.waitForFunction(() => typeof window.renderRecipe === 'function');
      const pageOpts: RenderPageOptions = { bitrate: opts.bitrate ?? 18_000_000, maxSeconds: opts.maxSeconds ?? 90 };
      return await page.evaluate(([r, o]) => window.renderRecipe(r, o), [recipe, pageOpts] as const);
    } catch (e) {
      throw new Error(`${(e as Error).message}${errors.length ? `\nPage errors:\n${errors.join('\n')}` : ''}`);
    } finally {
      await page.close();
      this.jobs.delete(jobId);
    }
  }

  async stop() {
    await this.browser?.close();
    await new Promise((ok) => (this.server ? this.server.close(ok) : ok(null)));
  }
}
