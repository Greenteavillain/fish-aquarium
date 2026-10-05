// Asset loading with byte-weighted progress.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

const THREE_VER = '0.186.1';
const DRACO_PATH = `https://cdn.jsdelivr.net/npm/three@${THREE_VER}/examples/jsm/libs/draco/gltf/`;

/**
 * Loads species.json, composition.json, all fish GLBs (near + far) and the environment.
 * onProgress(fraction 0..1, label).
 * WHY THREE.Cache: near and far GLBs reference the SAME atlas jpg; with the cache on, the second
 * request reuses the decoded image instead of fetching it again.  Only the near LOD's texture object
 * is kept (the far mesh is given the same material), so each atlas is uploaded to the GPU once.
 */
export async function loadAll(base, onProgress) {
  THREE.Cache.enabled = true;
  const getJSON = async (p) => {
    const r = await fetch(base + p);
    if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
    return r.json();
  };
  onProgress(0, '목록');
  const [speciesJson, comp] = await Promise.all([getJSON('species.json'), getJSON('composition.json')]);

  const draco = new DRACOLoader().setDecoderPath(DRACO_PATH);
  draco.setWorkerLimit(4);
  const gltf = new GLTFLoader().setDRACOLoader(draco);

  // byte weights for an honest progress bar
  const jobs = [];
  for (const s of speciesJson.species) {
    jobs.push({ key: s.id + ':near', url: s.files.near, bytes: s.bytes.near + s.bytes.atlas, label: s.name_ko });
    jobs.push({ key: s.id + ':far', url: s.files.far, bytes: s.bytes.far, label: s.name_ko });
  }
  const ef = comp.env_files;
  for (const k of ['sand', 'pillar', 'rocks_near', 'rocks_far']) {
    const e = ef[k];
    const bytes = e.glb_bytes + (e.albedo?.bytes || e.tile?.bytes || 0) + (e.normal?.bytes || e.tile?.normal_bytes || 0);
    jobs.push({ key: 'env:' + k, url: e.file, bytes, label: k === 'sand' ? '모래' : k === 'pillar' ? '바위 기둥' : '바위' });
  }
  const total = jobs.reduce((a, j) => a + j.bytes, 0);
  const done = new Map();
  const report = (label) => {
    let sum = 0; for (const j of jobs) sum += (done.get(j.key) || 0) * j.bytes;
    onProgress(sum / total, label);
  };
  const results = {};
  // limited concurrency: Draco decoding runs in 4 workers anyway
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const j = jobs[next++];
      // retry transient network failures (a dropped socket on a busy server/CDN) before giving up
      for (let attempt = 1; ; attempt++) {
        try {
          results[j.key] = await gltf.loadAsync(base + j.url, (ev) => {
            if (ev.lengthComputable) { done.set(j.key, 0.9 * ev.loaded / ev.total); report(j.label); }
          });
          break;
        } catch (e) {
          if (attempt >= 3) throw new Error(`${j.url}: ${e.message || e}`);
          await new Promise((r) => setTimeout(r, 400 * attempt));
        }
      }
      done.set(j.key, 1);
      report(j.label);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
  draco.dispose();
  const env = {};
  for (const k of ['sand', 'pillar', 'rocks_near', 'rocks_far']) env[k] = results['env:' + k];
  const fish = {};
  for (const s of speciesJson.species) {
    const pick = (g) => { let m = null; g.scene.traverse((o) => { if (o.isMesh && !m) m = o; }); return m; };
    const near = pick(results[s.id + ':near']), far = pick(results[s.id + ':far']);
    fish[s.id] = { geoNear: near.geometry, geoFar: far.geometry, map: near.material.map };
    // far.material is dropped (never rendered, so its texture is never uploaded).  Not dispose()d:
    // with THREE.Cache both textures wrap the SAME ImageBitmap, and disposing must not touch it.
  }
  return { speciesJson, comp, env, fish };
}
