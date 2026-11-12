import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { normalizeComposition, composeReferencePrompt } from '../public/composition.js';
import { parseRequest, compileGraph } from '../workflows.mjs';
import { createStudio } from '../server.mjs';
import { uploadPath } from '../uploads.mjs';

const ref = (role, name = role) => ({ role, name, uploadId: randomUUID() });
const composition = () => ({ references: [ref('scene'), ref('pose'), ref('person')], description: '中景平视，坐在窗边，端起杯子之前的静态画面。', style: 'realistic', size: '768x1024', seed: 42 });
test('reference numbering and actual image order share one canonical role order', async () => {
  const c = normalizeComposition(composition());
  assert.deepEqual(c.references.map(r => r.role), ['person', 'pose', 'scene']);
  const prompt = composeReferencePrompt(c);
  assert.match(prompt, /图1：人物 A/); assert.match(prompt, /图2：仅提供姿态/); assert.match(prompt, /图3：仅提供环境/);
  const parsed = parseRequest({ template: 'flux-compose', composition: c, prompt: 'untrusted replacement', images: ['wrong.png'] });
  assert.equal(parsed.prompt, prompt); assert.deepEqual(parsed.images, c.references.map(r => r.uploadId));
  const graph = JSON.parse(await readFile(new URL('../workflows/flux-3ref.json', import.meta.url)));
  const compiled = compileGraph(graph, { ...parsed, images: ['person.png', 'pose.png', 'scene.png'] }, randomUUID());
  assert.equal(compiled['4'].inputs.image, 'person.png'); assert.equal(compiled['19'].inputs.image, 'pose.png'); assert.equal(compiled['23'].inputs.image, 'scene.png');
  assert.ok(Object.values(compiled).some(n => n.class_type === 'CLIPTextEncode' && n.inputs.text === prompt));
});
test('two and five reference compositions connect only their intended image inputs', async () => {
  const graph = JSON.parse(await readFile(new URL('../workflows/flux-3ref.json', import.meta.url)));
  for (const roles of [['person', 'pose'], ['person', 'personB', 'outfit', 'pose', 'scene']]) {
    const c = { ...composition(), references: roles.map(role => ref(role)), mapping: 'A在左，B在右' };
    const parsed = parseRequest({ template: 'flux-compose', composition: c });
    const names = roles.map(role => role + '.png');
    const prompt = compileGraph(graph, { ...parsed, images: names }, randomUUID());
    assert.deepEqual(Object.values(prompt).filter(n => n.class_type === 'LoadImage').map(n => n.inputs.image), names);
    assert.equal(Object.values(prompt).filter(n => n.class_type === 'ReferenceLatent').length, roles.length);
    assert.ok(Object.values(prompt).filter(n => n.class_type === 'SaveImage').every(n => n.inputs.filename_prefix.startsWith('aigc-studio/')));
  }
});
test('ambiguous roles, duplicate images, missing identity, unmapped second person and invalid options are rejected', () => {
  const base = composition();
  for (const bad of [
    { ...base, references: [ref('pose'), ref('scene')] },
    { ...base, references: [ref('person'), ref('person')] },
    { ...base, references: [ref('person'), ref('personB')] },
    { ...base, references: [ref('person'), ref('other')] },
    { ...base, style: 'anything' }, { ...base, size: '90000x90000' }, { ...base, seed: -1 }, { ...base, description: 'a'.repeat(2001) }
  ]) assert.throws(() => normalizeComposition(bad));
  const same = ref('person'); assert.throws(() => normalizeComposition({ ...base, references: [same, { ...same, role: 'pose' }] }), /同一张图/);
});

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRQ0AAAAASUVORK5CYII=', 'base64');
async function harness(t) {
  const temp = await mkdtemp(resolve(tmpdir(), 'composer-test-')), engine = { submitted: [] };
  await mkdir(resolve(temp, 'workflows'), { recursive: true }); await mkdir(resolve(temp, 'data'));
  const graph = await readFile(new URL('../workflows/flux-3ref.json', import.meta.url)); await writeFile(resolve(temp, 'workflows/flux-3ref.json'), graph);
  const info = Object.fromEntries(JSON.parse(graph).nodes.filter(n => !['Note', 'PreviewImage'].includes(n.type)).map(n => [n.type, { input: { required: {} }, output: [] }]));
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const b of req) chunks.push(b);
    let result;
    if (req.url === '/object_info') result = info;
    else if (req.url === '/queue') result = { queue_running: [], queue_pending: engine.submitted.map(j => [1, j.prompt_id]) };
    else if (req.url.startsWith('/history')) result = {};
    else if (req.url === '/prompt') { const j = JSON.parse(Buffer.concat(chunks)); engine.submitted.push(j); result = { prompt_id: j.prompt_id }; }
    else if (req.url === '/system_stats') result = { devices: [] };
    else { res.writeHead(404); return res.end('{}'); }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
  });
  await new Promise(ok => upstream.listen(0, '127.0.0.1', ok));
  const app = createStudio({ comfyRoot: resolve(temp, 'engine'), comfyUrl: 'http://127.0.0.1:' + upstream.address().port, projectStorage: true }, { appRoot: temp, dataRoot: resolve(temp, 'data'), websocket: false });
  await new Promise(ok => app.server.listen(0, '127.0.0.1', ok));
  t.after(async () => { app.server.closeAllConnections(); upstream.closeAllConnections(); await Promise.all([new Promise(ok => app.server.close(ok)), new Promise(ok => upstream.close(ok))]); await rm(temp, { recursive: true, force: true }); });
  const url = 'http://127.0.0.1:' + app.server.address().port;
  const post = (path, body) => fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  async function image(role) {
    const id = randomUUID(), subfolder = 'AIGC项目/公共素材库/上传', filename = id + '.png';
    const path = resolve(temp, 'engine/output', subfolder, filename); await mkdir(resolve(path, '..'), { recursive: true }); await writeFile(path, Buffer.concat([pixel, Buffer.from(id)]));
    app.state.uploads[id] = { type: 'image/png', file: { type: 'output', subfolder, filename } };
    return { role, name: role, uploadId: id, path };
  }
  return { app, engine, temp, url, post, image };
}
test('generation endpoint saves role mapping and project/shot storage prefix, and retries do not enqueue twice', async t => {
  const h = await harness(t), refs = [await h.image('pose'), await h.image('person')];
  const projectId = randomUUID(), shotId = randomUUID();
  h.app.state.projects.push({ id: projectId, name: 'Test', catalog: [], characters: [], shots: [{ id: shotId, title: '镜头一', referenceIds: [], imageHistory: [], videoHistory: [] }] });
  const request = { requestId: randomUUID(), composition: { ...composition(), references: refs }, projectId, shotId };
  const response = await h.post('/api/composer/generate', request); assert.equal(response.status, 201, await response.clone().text());
  const job = await response.json(); assert.equal(job.template, 'flux-compose'); assert.equal(job.section, 'image'); assert.equal(job.projectId, projectId);
  assert.deepEqual(job.composition.references.map(r => r.role), ['person', 'pose']);
  const saved = h.engine.submitted[0].prompt;
  assert.match(saved['4'].inputs.image, new RegExp(refs[1].uploadId)); assert.match(saved['19'].inputs.image, new RegExp(refs[0].uploadId));
  assert.ok(Object.values(saved).filter(n => n.class_type === 'SaveImage').every(n => /AIGC项目\/Test_.*\/镜头001_/.test(n.inputs.filename_prefix)));
  assert.equal((await h.post('/api/composer/generate', request)).status, 201); assert.equal(h.engine.submitted.length, 1);
  assert.equal(h.app.state.projects[0].shots[0].imageHistory.length, 0, 'generation does not silently confirm or select a frame');
});
test('library selection registers the existing original once without copying it', async t => {
  const h = await harness(t), subfolder = 'AIGC项目/公共素材库/参考图库/CC0姿势';
  const path = resolve(h.temp, 'engine/output', subfolder, 'pose.png'); await mkdir(resolve(path, '..'), { recursive: true }); await writeFile(path, pixel);
  await writeFile(resolve(h.temp, 'data/reference-library.json'), JSON.stringify({ records: [{ id: 'test-pose', file: subfolder + '/pose.png', name: 'Pose', role: 'pose', license: 'CC0-1.0' }] }));
  const first = await (await h.post('/api/composer/library/use', { id: 'test-pose' })).json();
  const second = await (await h.post('/api/composer/library/use', { id: 'test-pose' })).json();
  assert.equal(first.uploadId, second.uploadId); assert.equal(Object.keys(h.app.state.uploads).length, 1);
  assert.deepEqual(await readdir(resolve(path, '..')), ['pose.png']);
  assert.equal((await fetch(h.url + '/api/composer/library/test-pose/image')).status, 200);
  await unlink(path); assert.deepEqual((await (await fetch(h.url + '/api/composer')).json()).library, []);
  assert.equal((await h.post('/api/composer/library/use', { id: 'test-pose' })).status, 404);
});
test('new projects cannot see another project references; deleted files invalidate recipes and generation', async t => {
  const h = await harness(t), person = await h.image('person'), pose = await h.image('pose'), pid = randomUUID();
  h.app.state.projects.push({ id: pid, name: 'Private', catalog: [], characters: [], shots: [] });
  const created = await (await h.post('/api/composer/references', { ...person, name: 'Private face', projectId: pid })).json();
  assert.equal((await (await fetch(h.url + '/api/composer/sources?projectId=' + pid)).json()).length, 1);
  assert.deepEqual(await (await fetch(h.url + '/api/composer/sources')).json(), []);
  const c = { ...composition(), references: [person, pose] };
  assert.equal((await h.post('/api/composer/recipes', { name: 'Recipe', composition: c })).status, 201);
  const response = await fetch(h.url + '/api/composer/references/' + created.id, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
  assert.equal(response.status, 200); assert.equal(h.app.state.compositionReferences.length, 0);
  const bootstrap = await (await fetch(h.url + '/api/composer')).json();
  assert.ok(bootstrap.recipes[0].missing.length); assert.equal(bootstrap.recipes[0].composition.references.length, 1);
  assert.equal((await h.post('/api/composer/generate', { composition: c })).status, 409); assert.equal(h.engine.submitted.length, 0);
});
test('library manifest cannot expose an image outside its dedicated media directory', async t => {
  const h = await harness(t), existing = await h.image('person');
  await writeFile(resolve(h.temp, 'data/reference-library.json'), JSON.stringify({ records: [{ id: 'escaped', role: 'person', name: 'Bad', file: 'AIGC项目/公共素材库/上传/' + existing.uploadId + '.png' }] }));
  assert.deepEqual((await (await fetch(h.url + '/api/composer')).json()).library, []);
  assert.equal((await fetch(h.url + '/api/composer/library/escaped/image')).status, 404);
});
test('fresh project uploads live under that project and project deletion clears their recipe references', async t => {
  const h = await harness(t), person = await h.image('person'), pose = await h.image('pose'), pid = randomUUID();
  h.app.state.projects.push({ id: pid, name: 'Own references', catalog: [], characters: [], shots: [] });
  assert.equal((await h.post('/api/composer/references', { ...person, name: 'My role', projectId: pid })).status, 201);
  const stored = uploadPath({ comfyRoot: resolve(h.temp, 'engine') }, h.app.state.uploads[person.uploadId]);
  assert.match(stored, /Own references_.*[\\/]角色[\\/]合成参考/);
  const assetId = randomUUID(); h.app.state.assets.push({ id: assetId, name: 'Folder-synced alias', category: 'character', uploadId: person.uploadId, ownerProjectId: pid });
  h.app.state.projects[0].catalog.push({ id: randomUUID(), category: 'character', assetIds: [assetId], defaultReferenceIds: [assetId] });
  const sources = await (await fetch(h.url + '/api/composer/sources?projectId=' + pid)).json();
  assert.equal(sources.length, 1); assert.equal(sources[0].custom, true);
  await h.post('/api/composer/recipes', { name: 'Owned', composition: { ...composition(), references: [person, pose] } });
  assert.equal((await fetch(h.url + '/api/projects/' + pid, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } })).status, 200);
  assert.equal(h.app.state.compositionReferences.length, 0);
  assert.equal(h.app.state.uploads[person.uploadId], undefined);
  assert.deepEqual(h.app.state.compositionRecipes[0].composition.references.map(r => r.role), ['pose']);
});
