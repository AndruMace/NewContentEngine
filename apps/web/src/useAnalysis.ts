import { useEffect, useRef, useState } from 'react';
import type { Recipe } from '@sim/engine';
import type { AnalysisResult } from './analysisWorker';

/**
 * Runs the recipe headlessly in a worker to get its exact duration and drama score.
 * Debounced; a newer recipe terminates any analysis still in flight, so heavy templates
 * (fluid, sand) never block the UI.
 */
export function useAnalysis(recipe: Recipe, delayMs = 200) {
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [pending, setPending] = useState(true);
  const workerRef = useRef<Worker | null>(null);
  const key = JSON.stringify(recipe);

  useEffect(() => {
    setPending(true);
    const timer = setTimeout(() => {
      workerRef.current?.terminate();
      const worker = new Worker(new URL('./analysisWorker.ts', import.meta.url), { type: 'module' });
      workerRef.current = worker;
      worker.onmessage = (e: MessageEvent<AnalysisResult>) => {
        if (e.data.key !== key) return;
        setResult(e.data);
        setPending(false);
        worker.terminate();
        if (workerRef.current === worker) workerRef.current = null;
      };
      worker.postMessage({ key, recipe });
    }, delayMs);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => () => workerRef.current?.terminate(), []);

  return { analysis: result?.key === key ? result : null, stale: result, pending };
}
