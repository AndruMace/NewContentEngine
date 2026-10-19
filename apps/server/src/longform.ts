/**
 * Long-form (ambient) videos from the Ambient page: create a job (Claude writes its YouTube copy
 * while it renders), cancel, retry, edit the copy, delete. Rendering itself is the scheduler's.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { loopLengthOf, type Recipe } from '@sim/engine';
import { claudeAvailable, claudeErrorReason, fallbackLongFormCopy, longFormCopyFromClaude, type LongFormCopy } from '@sim/planner';
import { RENDERS_DIR } from '@sim/render';
import { findTemplate } from '@sim/templates';
import { deleteLongFormJob, getLongFormJob, insertLongFormJob, updateLongFormJob, type LongFormJob } from './longformJobs';
import type { RenderScheduler } from './scheduler';

/** YouTube's upload limit is 12 hours. */
const MAX_TOTAL_S = 12 * 3600;

export class LongFormService {
  constructor(private scheduler: RenderScheduler, private changed: (id: string) => void) {}

  create(recipe: Recipe, notes?: string | null): LongFormJob {
    const template = findTemplate(recipe.templateId);
    if (!template?.longForm) throw new Error(`${recipe.templateId} is not a long-form template`);
    const loopS = loopLengthOf(template, recipe.loopS);
    const totalS = Math.round(Math.min(MAX_TOTAL_S, Math.max(loopS, recipe.totalS ?? loopS)));
    const job = insertLongFormJob({ ...recipe, loopS, totalS, copy: {} }, notes?.trim() || null);
    void this.writeCopy(job.id);
    this.scheduler.notify();
    this.changed(job.id);
    return job;
  }

  /** Claude's copy (or the plain fallback), written while the video renders. */
  async writeCopy(id: string, notes?: string | null) {
    const job = getLongFormJob(id);
    if (!job) return;
    if (notes !== undefined) updateLongFormJob(id, { notes: notes?.trim() || null });
    if (!claudeAvailable()) {
      updateLongFormJob(id, { copy: fallbackLongFormCopy(job.recipe), copyStatus: 'ready', copyError: 'No Anthropic API key (ANTHROPIC_API_KEY in .env): plain copy.' });
      this.changed(id);
      return;
    }
    updateLongFormJob(id, { copyStatus: 'writing', copyError: null });
    this.changed(id);
    try {
      const copy = await longFormCopyFromClaude(new Anthropic(), job.recipe, notes ?? job.notes);
      updateLongFormJob(id, { copy, copyStatus: 'ready' });
    } catch (e) {
      updateLongFormJob(id, { copy: job.copy ?? fallbackLongFormCopy(job.recipe), copyStatus: 'failed', copyError: `Claude couldn't write the copy (${claudeErrorReason(e)}): plain copy instead.` });
    }
    this.changed(id);
  }

  editCopy(id: string, patch: Partial<LongFormCopy>) {
    const job = getLongFormJob(id);
    if (!job) throw new Error('not found');
    const base = job.copy ?? fallbackLongFormCopy(job.recipe);
    const tags = patch.tags?.map((t) => t.trim()).filter(Boolean);
    updateLongFormJob(id, { copy: { ...base, ...patch, ...(tags ? { tags } : {}) }, copyStatus: 'ready' });
    this.changed(id);
  }

  cancel(id: string) {
    this.scheduler.cancelLongForm(id);
    this.changed(id);
  }

  /** Queue a cancelled or failed job again: it resumes after its last finished segment. */
  retry(id: string) {
    const job = getLongFormJob(id);
    if (!job || !['cancelled', 'failed'].includes(job.status)) throw new Error('only a cancelled or failed video can be retried');
    updateLongFormJob(id, { status: 'queued', error: null });
    this.scheduler.notify();
    this.changed(id);
  }

  /** Remove the job, and with `files` its folder on disk too (the video and the master loop). */
  async remove(id: string, files: boolean) {
    const job = getLongFormJob(id);
    if (!job) return;
    if (job.status === 'rendering') throw new Error('cancel it first');
    if (files && job.dir) await rm(join(RENDERS_DIR, job.dir), { recursive: true, force: true });
    deleteLongFormJob(id);
    this.changed(id);
  }
}
