/**
 * The deterministic build of the Rapier physics engine (identical results in Node and Chrome, which
 * the render QC relies on). Its WASM is inlined, and it is initialised once with a top-level await,
 * so anything importing the templates waits for it.
 */
import RAPIER from '@dimforge/rapier3d-deterministic-compat';

await RAPIER.init();

export { RAPIER };
