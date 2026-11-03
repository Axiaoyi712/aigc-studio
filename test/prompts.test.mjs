import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createStudio } from '../server.mjs';

test('prompt search, favorites, custom copies and source containment preserve originals', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'aigc-library-test-'));
  const source = resolve(root, 'originals');
  await mkdir(source); await mkdir(resolve(root, 'library'));
  await writeFile(resolve(source, 'camera.txt'), 'original camera text');
  const entries = [
    { id: 'camera', title: 'Camera push', body: 'A gentle push near the lake.', source: 'camera.txt', kind: 'video', group: 'video' },
    { id: 'director', title: 'Director', body: 'Analyze the script and output JSON.', source: 'camera.txt', kind: 'instruction', group: 'video' },
    { id: 'escape', title: 'Invalid source', body: 'test', source: '../outside.txt', kind: 'reference' }
  ];
  await writeFile(resolve(root, 'outside.txt'), 'outside');
  await writeFile(resolve(root, 'library/catalog.json'), JSON.stringify({ sources: ['camera.txt'], entries, issues: [] }));
  const app = createStudio({ name: 'test', comfyRoot: root, comfyUrl: 'http://127.0.0.1:1', promptLibraryRoot: source }, { appRoot: root, websocket: false });
  await new Promise(ok => app.server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { app.server.closeAllConnections(); await new Promise(ok => app.server.close(ok)); await rm(root, { recursive: true, force: true }); });
  const get = async path => (await fetch(url + path)).json();
  const post = (path, body) => fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await get('/api/prompts?search=push%20lake&kind=video')).total, 1);
  assert.equal((await get('/api/prompts?kind=instruction')).items[0].id, 'director');
  assert.equal((await post('/api/prompts/favorite', { id: 'camera', favorite: true })).status, 200);
  assert.equal((await get('/api/prompts?favorites=1')).total, 1);
  assert.equal((await post('/api/prompts/custom', { title: 'Mine', body: 'Edited camera description', kind: 'video' })).status, 201);
  assert.equal((await get('/api/prompts?group=' + encodeURIComponent('我的提示词'))).total, 1);
  assert.equal((await post('/api/prompts/custom', { title: 'bad', body: '', kind: 'video' })).status, 400);
  const persisted = JSON.parse(await readFile(resolve(root, 'data/state.json'), 'utf8'));
  assert.equal(persisted.userPrompts.length, 1); assert.deepEqual(persisted.promptFavorites, ['camera']);
  assert.equal(await (await fetch(url + '/api/prompts/camera/source')).text(), 'original camera text');
  assert.equal((await fetch(url + '/api/prompts/escape/source')).status, 403);
  assert.equal(await readFile(resolve(source, 'camera.txt'), 'utf8'), 'original camera text');
});
