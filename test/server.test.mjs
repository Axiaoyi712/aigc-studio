import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createStudio } from '../server.mjs';
import { videoMatches } from '../production.mjs';

test('native refinement tasks are never reconciled against ComfyUI history',async t=>{
  const h=await harness(t);const item={id:randomUUID(),template:'video-upscale',status:'running',outputs:[]};h.app.state.jobs.push(item);await h.app.refresh();assert.equal(item.status,'running');
});

async function listenLocal(server) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await new Promise((ok, reject) => { server.once('error', reject); server.listen(20000 + Math.floor(Math.random() * 40000), '127.0.0.1', () => { server.removeListener('error', reject); ok(); }); });
      return;
    } catch (error) { if (!['EADDRINUSE','EACCES'].includes(error.code)) throw error; }
  }
  throw Error('No available test port.');
}

async function harness(t,enableRef2VA=false) {
  const temp = await mkdtemp(resolve(tmpdir(), 'aigc-studio-test-'));
  await mkdir(resolve(temp, 'workflows'));
  await writeFile(resolve(temp, 'workflows/flux-edit.json'), JSON.stringify({ nodes: [{ id: 1, type: 'LoadImage', widgets_values: ['example.png'] }, { id: 2, type: 'SaveImage', widgets_values: ['test'], inputs: [{ name: 'images', link: 1 }] }], links: [[1, 1, 0, 2, 0, 'IMAGE']] }));
  await writeFile(resolve(temp,'workflows/h3-fast.json'),await readFile(resolve(temp,'workflows/flux-edit.json')));
  const engine = { running: [], pending: [], history: {}, submitted: [], cancelled: [], forceBusy: false };
  const upstream = http.createServer(async (req, res) => {
    let value;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    if (req.url === '/object_info') value = { LoadImage: { input: { required: { image: [['example.png']] } }, output: ['IMAGE'] }, SaveImage: { input: { required: { images: ['IMAGE'], filename_prefix: ['STRING'] } }, output: [] } };
    else if (req.url === '/upload/image') value = { name: 'ref.png', subfolder: 'aigc-studio', type: 'input' };
    else if(req.url.startsWith('/view?')){(engine.viewed??=[]).push(req.url);res.writeHead(200,{'Content-Type':'image/png'});return res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRQ0AAAAASUVORK5CYII=','base64'));}
    else if (req.url === '/queue' && req.method === 'GET') value = { queue_running: engine.forceBusy ? [[0, 'another-users-job']] : engine.running, queue_pending: engine.pending };
    else if (req.url.startsWith('/history/')) { const id = req.url.split('/').at(-1); value = engine.history[id] ? { [id]: engine.history[id] } : {}; }
    else if (req.url === '/prompt') { const input = JSON.parse(body); engine.submitted.push(input); engine.running = [[0, input.prompt_id]]; value = { prompt_id: input.prompt_id }; }
    else if (req.url === '/interrupt') { engine.cancelled.push(JSON.parse(body)); res.writeHead(200); return res.end(); }
    else if (req.url === '/queue' && req.method === 'POST') { engine.cancelled.push(JSON.parse(body)); res.writeHead(200); return res.end(); }
    else if (req.url === '/system_stats') value = { devices: [] };
    else { res.writeHead(404); return res.end('{}'); }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value));
  });
  await listenLocal(upstream);
  const config = { name: 'test', comfyRoot: resolve(temp, 'missing'), comfyUrl: `http://127.0.0.1:${upstream.address().port}`,enableRef2VA };
  const app = createStudio(config, { appRoot: temp, websocket: false });
  await listenLocal(app.server);
  const url = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { app.server.closeAllConnections(); upstream.closeAllConnections(); await Promise.all([new Promise(ok => app.server.close(ok)), new Promise(ok => upstream.close(ok))]); await rm(temp, { recursive: true, force: true }); });
  const post = (path, value, headers = {}) => fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) });
  const upload = async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRQ0AAAAASUVORK5CYII=', 'base64');
    return (await fetch(url + '/api/uploads', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png })).json();
  };
  return { app, engine, url, post, upload, temp, engineUrl: config.comfyUrl };
}

test('foreign origins, fake images, unregistered uploads and empty prompts are rejected', async t => {
  const h = await harness(t);
  assert.equal((await h.post('/api/jobs', {}, { Origin: 'https://example.com' })).status, 403);
  assert.equal((await fetch(h.url + '/api/uploads', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: 'not-an-image' })).status, 400);
  assert.equal((await h.post('/api/jobs', { template: 'flux-edit', prompt: '', images: ['missing'] })).status, 400);
  assert.equal((await h.post('/api/jobs', { template: 'flux-edit', prompt: 'a cabin', images: ['missing'] })).status, 400);
  assert.equal(h.engine.submitted.length, 0);
});
test('duplicate submission is idempotent and new tasks respect a busy engine', async t => {
  const h = await harness(t);
  const image = await h.upload();
  const request = { requestId: randomUUID(), template: 'flux-edit', prompt: 'A lakeside cabin', images: [image.id] };
  const first = await h.post('/api/jobs', request);
  assert.equal(first.status, 201);
  assert.equal((await first.json()).status, 'queued');
  assert.equal((await h.post('/api/jobs', request)).status, 200);
  assert.equal(h.engine.submitted.length, 1);
  assert.equal((await h.post('/api/jobs', { ...request, requestId: randomUUID() })).status, 409);
  assert.equal(h.engine.submitted.length, 1);
});
test('cancellation targets only the owned running job and accepts an empty engine response', async t => {
  const h = await harness(t);
  const image = await h.upload();
  const id = randomUUID();
  await h.post('/api/jobs', { requestId: id, template: 'flux-edit', prompt: 'A cabin', images: [image.id] });
  assert.equal((await h.post(`/api/jobs/${id}/cancel`, {})).status, 200);
  assert.deepEqual(h.engine.cancelled, [{ prompt_id: id }]);
  h.engine.forceBusy = true;
  await h.post(`/api/jobs/${id}/cancel`, {});
  assert.equal(h.engine.cancelled.length, 1);
});
test('completed history produces a retrievable result and retains its generation parameters', async t => {
  const h = await harness(t);
  const image = await h.upload();
  const id = randomUUID();
  await h.post('/api/jobs', { requestId: id, template: 'flux-edit', prompt: 'A cabin', images: [image.id], seed: 314 });
  h.engine.running = [];
  h.engine.history[id] = { status: { status_str: 'success', completed: true }, outputs: { 2: { images: [{ filename: 'result.png', subfolder: 'aigc-studio', type: 'output' }] } } };
  await h.app.refresh();
  const jobs = await (await fetch(h.url + '/api/jobs')).json();
  assert.equal(jobs[0].status, 'success');
  assert.equal(jobs[0].seed, 314);
  assert.equal(jobs[0].outputs[0].url, `/api/media/${id}/0`);
});
test('an engine already busy with an unrelated task receives no submission', async t => {
  const h = await harness(t);
  const image = await h.upload();
  h.engine.forceBusy = true;
  assert.equal((await h.post('/api/jobs', { template: 'flux-edit', prompt: 'A cabin', images: [image.id] })).status, 409);
  assert.equal(h.engine.submitted.length, 0);
});

async function threeShotProject(h) {
  const upload = await h.upload();
  const asset = await (await h.post('/api/assets', { name: 'Test character', category: 'character', uploadId: upload.id })).json();
  const project = await (await h.post('/api/projects', { name: 'Three shot test' })).json();
  project.shots = [0, 1, 2].map(i => ({ id: randomUUID(), title: `Shot ${i}`, imagePrompt: `Image ${i}`, videoPrompt: `Motion ${i}`, referenceIds: [asset.id], seed: i }));
  const saved = await h.post('/api/projects/' + project.id, project);
  assert.equal(saved.status, 200, await saved.text());
  return project;
}

test('one-click persists both stages, is idempotent, confirms its new frame and animates that exact frame',async t=>{
  const h=await harness(t);const project=await threeShotProject(h);
  project.shots=project.shots.slice(0,1);const shot=project.shots[0];
  shot.generalPrompt='湖边小屋，水面缓缓起伏，自然环境声。';shot.imagePrompt='';shot.videoPrompt='';
  assert.equal((await h.post('/api/projects/'+project.id,project)).status,200);
  await h.post('/api/batch-queue/pause',{paused:true});
  const body={requestId:randomUUID(),kind:'both',shotIds:[shot.id]};
  const first=await h.post(`/api/projects/${project.id}/batch`,body);assert.equal(first.status,201,await first.clone().text());
  const items=await first.json();assert.equal(items.length,2);const [image,video]=items;
  assert.deepEqual(items.map(i=>i.kind),['image','video']);assert.equal(video.frameJobId,image.id);assert.equal(video.dependsOnId,image.id);
  const duplicate=await h.post(`/api/projects/${project.id}/batch`,body);assert.equal(duplicate.status,201);assert.deepEqual((await duplicate.json()).map(i=>i.id),items.map(i=>i.id));assert.equal(h.app.state.batchQueue.length,2);
  const stored=JSON.parse(await readFile(resolve(h.temp,'data/state.json'),'utf8'));assert.equal(stored.projects[0].shots[0].generalPrompt,shot.generalPrompt);assert.equal(stored.batchQueue[1].dependsOnId,image.id);
  await h.post('/api/batch-queue/pause',{paused:false});await h.app.tick();assert.equal(h.engine.submitted.length,1);assert.equal(h.engine.submitted[0].prompt_id,image.id);
  h.engine.running=[];h.engine.history[image.id]={status:{status_str:'success',completed:true},outputs:{2:{images:[{filename:'new.png',subfolder:'aigc-studio',type:'output'}]}}};
  await h.app.tick();assert.equal(h.engine.submitted.length,2);assert.equal(h.engine.submitted[1].prompt_id,video.id);
  const current=h.app.state.projects[0].shots[0];assert.equal(current.confirmedFrameJobId,image.id);assert.equal(current.videoJobId,video.id);assert.deepEqual(current.imageHistory,[image.id]);
  const videoJob=h.app.state.jobs.find(j=>j.id===video.id);assert.equal(videoJob.frameJobId,image.id);
  h.engine.running=[];h.engine.history[video.id]={status:{status_str:'success',completed:true},outputs:{2:{gifs:[{filename:'clip.mp4',subfolder:'aigc-studio',type:'output'}]}}};
  await h.app.tick();assert.equal(h.app.state.batchQueue[1].status,'success');assert.ok(videoMatches(h.app.state.projects[0],current,videoJob,h.app.state.assets));
});

test('one-click image failure or waiting cancellation cancels its dependent video without submission',async t=>{
  const h=await harness(t);const project=await threeShotProject(h);await h.post('/api/batch-queue/pause',{paused:true});
  const batch=()=>h.post(`/api/projects/${project.id}/batch`,{requestId:randomUUID(),kind:'both',shotIds:[project.shots[0].id]});
  const first=await(await batch()).json();await h.post(`/api/batch-queue/${first[0].id}/cancel`,{});
  assert.ok(h.app.state.batchQueue.every(i=>i.status==='cancelled'));assert.equal(h.engine.submitted.length,0);
  const second=await(await batch()).json();await h.post('/api/batch-queue/pause',{paused:false});await h.app.tick();
  h.engine.running=[];h.engine.history[second[0].id]={status:{status_str:'error',completed:false,messages:[['execution_error',{exception_message:'test failure'}]]},outputs:{}};
  await h.app.tick();assert.equal(h.app.state.batchQueue.find(i=>i.id===second[1].id).status,'cancelled');assert.equal(h.engine.submitted.length,1);assert.equal(h.app.state.queuePaused,true);
});

test('one-click resumes from persisted state after a studio restart between its two stages',async t=>{
  const h=await harness(t);const project=await threeShotProject(h);project.shots[0].generalPrompt='湖面微风，固定机位。';await h.post('/api/projects/'+project.id,project);
  await h.post('/api/batch-queue/pause',{paused:true});
  const [image,video]=await(await h.post(`/api/projects/${project.id}/batch`,{requestId:randomUUID(),kind:'both',shotIds:[project.shots[0].id]})).json();
  await h.post('/api/batch-queue/pause',{paused:false});await h.app.tick();assert.equal(h.engine.submitted.length,1);
  h.app.server.closeAllConnections();await new Promise(ok=>h.app.server.close(ok));
  h.engine.running=[];h.engine.history[image.id]={status:{status_str:'success',completed:true},outputs:{2:{images:[{filename:'resumed.png',subfolder:'aigc-studio',type:'output'}]}}};
  const resumed=createStudio({name:'resumed',comfyRoot:resolve(h.temp,'missing'),comfyUrl:h.engineUrl},{appRoot:h.temp,websocket:false});await listenLocal(resumed.server);
  t.after(async()=>{resumed.server.closeAllConnections();await new Promise(ok=>resumed.server.close(ok));});
  await resumed.tick();assert.equal(h.engine.submitted.length,2);assert.equal(h.engine.submitted[1].prompt_id,video.id);assert.equal(resumed.state.projects[0].shots[0].confirmedFrameJobId,image.id);assert.equal(resumed.state.projects[0].shots[0].generalPrompt,project.shots[0].generalPrompt);
});

test('confirming a historical frame survives a stale editor save and video submission fetches that exact older frame',async t=>{
  const h=await harness(t),project=await threeShotProject(h);const shot=h.app.state.projects[0].shots[0];
  const frames=['old.png','latest.png'].map(filename=>({id:randomUUID(),projectId:project.id,shotId:shot.id,status:'success',section:'image',images:[],outputs:[{index:0,kind:'image',type:'output',subfolder:'aigc-studio',filename}]}));
  h.app.state.jobs.push(...frames);shot.imageHistory=frames.map(j=>j.id);shot.imageJobId=frames[1].id;shot.confirmedFrameJobId=frames[1].id;
  const staleEditor=structuredClone(h.app.state.projects[0]);
  assert.equal((await h.post(`/api/projects/${project.id}/select`,{shotId:shot.id,kind:'image',jobId:frames[0].id})).status,200);
  staleEditor.shots[0].videoPrompt='修改后的视频动作';assert.equal((await h.post('/api/projects/'+project.id,staleEditor)).status,200);
  const current=h.app.state.projects[0].shots[0];assert.equal(current.imageJobId,frames[0].id);assert.equal(current.confirmedFrameJobId,frames[0].id);
  await h.post('/api/batch-queue/pause',{paused:true});const response=await h.post(`/api/projects/${project.id}/batch`,{requestId:randomUUID(),kind:'video',shotIds:[shot.id]});assert.equal(response.status,201);
  const [item]=await response.json();assert.equal(item.frameJobId,frames[0].id);await h.post('/api/batch-queue/pause',{paused:false});await h.app.tick();
  assert.equal(h.engine.submitted.length,1);assert.equal(h.app.state.jobs.find(j=>j.id===item.id).frameJobId,frames[0].id);assert.equal(h.engine.submitted[0].prompt['1'].inputs.image,'aigc-studio/old.png [output]');assert.equal(h.engine.viewed?.length||0,0);
});

test('general prompt length and both-stage reference checks reject atomically',async t=>{
  const h=await harness(t,true);const project=await threeShotProject(h);
  project.shots[0].generalPrompt='中'.repeat(6001);const before=h.app.state.projects[0].shots[0].generalPrompt;
  assert.equal((await h.post('/api/projects/'+project.id,project)).status,400);assert.equal(h.app.state.projects[0].shots[0].generalPrompt,before);
  project.shots[0].generalPrompt='湖水轻轻起伏';project.videoTemplate='h3-reference';project.video={frames:73,aspect:'landscape',profile:'draft'};
  const asset=h.app.state.assets[0];for(let i=0;i<3;i++){const a=await(await h.post('/api/assets',{name:'scene'+i,category:'scene',uploadId:asset.uploadId})).json();project.shots[0].referenceIds.push(a.id);}
  assert.equal((await h.post('/api/projects/'+project.id,project)).status,200);
  const r=await h.post(`/api/projects/${project.id}/batch`,{requestId:randomUUID(),kind:'both',shotIds:[project.shots[0].id]});assert.equal(r.status,400);assert.match((await r.json()).error,/最多使用 3/);assert.equal(h.app.state.batchQueue.length,0);
});

test('project characters enter real reference inputs and stale character frames cannot be confirmed or animated', async t => {
  const h = await harness(t); const project = await threeShotProject(h);
  const first = h.app.state.assets[0]; const upload = await h.upload();
  const second = await (await h.post('/api/assets',{name:'Role B',category:'character',uploadId:upload.id})).json();
  project.characters = [{id:randomUUID(),name:'Swordsman',description:'Black ponytail and black gold coat.',referenceIds:[first.id]},{id:randomUUID(),name:'Mage',description:'White hair and red coat.',referenceIds:[second.id]}];
  for(const shot of project.shots){shot.referenceIds=[];shot.characterIds=project.characters.map(role=>role.id);}
  assert.equal((await h.post('/api/projects/'+project.id,project)).status,200);
  await h.post('/api/batch-queue/pause',{paused:true});
  const batch = kind => h.post(`/api/projects/${project.id}/batch`,{requestId:randomUUID(),kind,shotIds:[project.shots[0].id]});
  assert.equal((await batch('image')).status,201);
  const imageItem = h.app.state.batchQueue.at(-1);
  assert.equal(imageItem.input.template,'flux-2ref');
  assert.deepEqual(imageItem.input.images,[first.uploadId,second.uploadId]);
  assert.match(imageItem.input.prompt,/Swordsman/);assert.match(imageItem.input.prompt,/White hair/);
  assert.equal(imageItem.characterSignature.length,64);
  await h.post(`/api/batch-queue/${imageItem.id}/cancel`,{});
  const frameId=randomUUID();const shot=h.app.state.projects[0].shots[0];
  h.app.state.jobs.push({id:frameId,status:'success',characterSignature:imageItem.characterSignature,projectId:project.id,shotId:shot.id,outputs:[{kind:'image',type:'output',filename:'frame.png',subfolder:'aigc-studio',index:0}]});
  shot.imageHistory.push(frameId);
  assert.equal((await h.post(`/api/projects/${project.id}/select`,{shotId:shot.id,kind:'image',jobId:frameId})).status,200);
  assert.equal((await batch('video')).status,201);
  const videoItem=h.app.state.batchQueue.at(-1);
  assert.equal(videoItem.characterSignature,imageItem.characterSignature);assert.equal(videoItem.frameJobId,frameId);
  assert.match(videoItem.input.prompt,/Swordsman/);
  await h.post(`/api/batch-queue/${videoItem.id}/cancel`,{});
  project.characters[0].description='Changed outfit';
  assert.equal((await h.post('/api/projects/'+project.id,project)).status,200);
  const snapshot=await(await fetch(h.url+'/api/projects/'+project.id)).json();
  assert.notEqual(snapshot.characterSignatures[shot.id],imageItem.characterSignature);
  assert.equal((await batch('video')).status,400);
  assert.equal((await h.post(`/api/projects/${project.id}/select`,{shotId:shot.id,kind:'image',jobId:frameId})).status,400);
  const count=h.app.state.batchQueue.length;
  const more=[];
  for(let i=0;i<19;i++)more.push(await(await h.post('/api/assets',{name:'Extra '+i,category:'character',uploadId:first.uploadId})).json());
  project.characters[0].referenceIds=[first.id,...more.map(asset=>asset.id)];
  assert.equal((await h.post('/api/projects/'+project.id,project)).status,200);
  assert.equal((await batch('image')).status,400);assert.equal(h.app.state.batchQueue.length,count);
});

test('using the previous tail requires a completed matching predecessor and reuses an existing extracted frame', async t => {
  const h = await harness(t);
  const project = await threeShotProject(h);
  const stored = h.app.state.projects[0];
  const path = `/api/projects/${project.id}/use-previous-tail`;
  assert.equal((await h.post(path, { shotId: stored.shots[0].id })).status, 400);
  assert.equal((await h.post(path, { shotId: stored.shots[1].id })).status, 400);
  assert.equal((await h.post(path, { shotId: randomUUID() })).status, 404);
  const frameId = randomUUID(); const videoId = randomUUID(); const tailId = randomUUID();
  const folder = resolve(h.temp, 'missing/output/aigc-studio');
  await mkdir(folder, { recursive: true });
  await writeFile(resolve(folder, 'source.mp4'), 'owned video fixture');
  await writeFile(resolve(folder, 'tail.png'), 'owned extracted frame fixture');
  h.app.state.jobs.push({ id: frameId, status: 'success', outputs: [{ kind: 'image',type:'output',filename:'frame.png',subfolder:'aigc-studio',index:0 }] });
  h.app.state.jobs.push({ id: videoId, status: 'success', frameJobId: frameId, outputs: [{ kind: 'video', type: 'output', subfolder: 'aigc-studio', filename: 'source.mp4' }] });
  h.app.state.jobs.push({ id: tailId, status: 'success', sourceVideoJobId: videoId, outputs: [{ index: 0, kind: 'image', type: 'output', subfolder: 'aigc-studio', filename: 'tail.png' }] });
  stored.shots[0].confirmedFrameJobId = frameId; stored.shots[0].videoJobId = videoId;
  stored.shots[1].imageHistory = [tailId];
  const count = h.app.state.jobs.length;
  for (let i = 0; i < 2; i++) {
    const response = await h.post(path, { shotId: stored.shots[1].id });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).frame.id, tailId);
    assert.equal(stored.shots[1].confirmedFrameJobId, tailId);
    assert.equal(h.app.state.jobs.length, count);
  }
  stored.shots[0].confirmedFrameJobId = randomUUID();
  assert.equal((await h.post(path, { shotId: stored.shots[1].id })).status, 400);
  assert.equal(stored.shots[1].confirmedFrameJobId, tailId);
  stored.shots[0].confirmedFrameJobId = frameId;
  h.app.state.batchQueue.push({ id: randomUUID(), projectId: stored.id, status: 'waiting' });
  assert.equal((await h.post(path, { shotId: stored.shots[1].id })).status, 409);
});

for (const frames of [175, 243, 362]) for (const profile of ['draft', 'standard', 'high']) test(`${frames}-frame ${profile} project settings persist, reject invalid edits atomically and enter the queue snapshot`, async t => {
  const h = await harness(t);
  const project = await threeShotProject(h);
  project.video = { frames, profile, aspect: 'square', sound: 'mute' };
  assert.equal((await h.post('/api/projects/' + project.id, project)).status, 200);
  const stored = h.app.state.projects[0];
  const frameId = randomUUID();
  h.app.state.jobs.push({ id: frameId, status: 'success', outputs: [{ kind: 'image',type:'output',filename:'frame.png',subfolder:'aigc-studio',index:0 }] });
  stored.shots[0].confirmedFrameJobId = frameId;
  await h.post('/api/batch-queue/pause', { paused: true });
  const response = await h.post(`/api/projects/${project.id}/batch`, { requestId: randomUUID(), kind: 'video', shotIds: [stored.shots[0].id] });
  assert.equal(response.status, 201);
  assert.equal((await response.json())[0].input.video.frames, frames);
  assert.equal(h.app.state.batchQueue[0].input.video.sound, 'mute');
  assert.equal(h.app.state.batchQueue[0].input.video.profile, profile);
  await h.post(`/api/batch-queue/${h.app.state.batchQueue[0].id}/cancel`, {});
  const invalid = await h.post('/api/projects/' + project.id, { ...project, name: 'invalid', video: { frames, profile: 'unknown' } });
  assert.equal(invalid.status, 400); assert.equal(stored.name, project.name);
  assert.equal(stored.video.frames, frames);
});
test('a three-shot batch is idempotent, serial and retains confirmed first frames and ordering', async t => {
  const h = await harness(t);
  const project = await threeShotProject(h);
  const batch = { requestId: randomUUID(), kind: 'image', shotIds: project.shots.map(shot => shot.id) };
  await h.post(`/api/projects/${project.id}/batch`, batch);
  await h.post(`/api/projects/${project.id}/batch`, batch);
  assert.equal(h.app.state.batchQueue.length, 3);
  assert.equal((await h.post('/api/projects/' + project.id, project)).status, 409);
  for (let i = 0; i < 3; i++) {
    await h.app.tick();
    assert.equal(h.engine.submitted.length, i + 1);
    await h.app.tick();
    assert.equal(h.engine.submitted.length, i + 1);
    const id = h.engine.submitted[i].prompt_id;
    h.engine.running = [];
    h.engine.history[id] = { status: { status_str: 'success', completed: true }, outputs: { 2: { images: [{ filename: `result${i}.png`, subfolder: 'aigc-studio', type: 'output' }] } } };
  }
  await h.app.tick();
  const snapshot = await (await fetch(h.url + `/api/projects/${project.id}`)).json();
  assert.deepEqual(snapshot.project.shots.map(shot => shot.id), batch.shotIds);
  assert.ok(snapshot.queue.every(item => item.status === 'success'));
  for (const shot of snapshot.project.shots) {
    assert.equal((await h.post(`/api/projects/${project.id}/select`, { shotId: shot.id, kind: 'image', jobId: shot.imageJobId })).status, 200);
  }
  assert.equal((await h.post(`/api/projects/${project.id}/export`, {})).status, 400);
  assert.ok(h.app.state.projects[0].shots.every(shot => shot.confirmedFrameJobId === shot.imageJobId));
});
test('failed generation pauses subsequent shots; pending tasks can be cancelled without interrupting another job', async t => {
  const h = await harness(t);
  const project = await threeShotProject(h);
  await h.post(`/api/projects/${project.id}/batch`, { requestId: randomUUID(), kind: 'image', shotIds: project.shots.map(shot => shot.id) });
  await h.post('/api/batch-queue/pause', { paused: true });
  await h.app.tick(); assert.equal(h.engine.submitted.length, 0);
  await h.post('/api/batch-queue/pause', { paused: false });
  await h.app.tick();
  const id = h.engine.submitted[0].prompt_id;
  h.engine.running = [];
  h.engine.history[id] = { status: { status_str: 'error', completed: true, messages: [['execution_error', { exception_message: 'GPU test failure' }]] }, outputs: {} };
  await h.app.tick();
  assert.equal(h.app.state.queuePaused, true);
  assert.equal(h.engine.submitted.length, 1);
  const pending = h.app.state.batchQueue[1];
  assert.equal((await h.post(`/api/batch-queue/${pending.id}/cancel`, {})).status, 200);
  assert.equal(pending.status, 'cancelled'); assert.equal(h.engine.cancelled.length, 0);
});
test('invalid project edits are atomic and a rejected multi-shot batch creates no partial queue', async t => {
  const h = await harness(t);
  const project = await threeShotProject(h);
  const invalid = structuredClone(project); invalid.name = 'Must not apply'; invalid.shots[1].seed = -1;
  assert.equal((await h.post('/api/projects/' + project.id, invalid)).status, 400);
  assert.equal(h.app.state.projects[0].name, project.name);
  assert.equal((await h.post(`/api/projects/${project.id}/batch`, { requestId: randomUUID(), kind: 'video', shotIds: project.shots.map(shot => shot.id) })).status, 400);
  assert.equal(h.app.state.batchQueue.length, 0);
});

test('studio and original launcher records resolve to the most recent engine address', async t => {
  const h = await harness(t);
  const shared = resolve(h.temp, '.launcher/port-check');
  await mkdir(shared, { recursive: true });
  await writeFile(resolve(shared, 'last-start.json'), JSON.stringify({ CheckedAt: '2026-01-01T00:00:00Z', URL: 'http://127.0.0.1:1' }));
  await writeFile(resolve(h.temp, 'data/comfy-server.json'), JSON.stringify({ CheckedAt: '2026-02-01T00:00:00Z', URL: h.engineUrl }));
  let status = await (await fetch(h.url + '/api/status')).json();
  assert.equal(status.connected, true); assert.equal(status.engineUrl, h.engineUrl);
  await writeFile(resolve(shared, 'last-start.json'), JSON.stringify({ CheckedAt: '2026-03-01T00:00:00Z', URL: 'http://127.0.0.1:1' }));
  status = await (await fetch(h.url + '/api/status')).json();
  assert.equal(status.engineUrl, 'http://127.0.0.1:1');
});
test('project planning persists production, per-shot duration and immutable input snapshots',async t=>{
  const h=await harness(t),p=await threeShotProject(h);
  p.production={style:'雨夜动画',frameQuality:'standard',frameAspect:'landscape',exportSize:'1280x720',referenceIds:[]};
  p.shots[0].director={position:'人物在右侧',action:'轻轻抬头',camera:'push',sound:'雨声'};p.shots[0].frames=73;
  assert.equal((await h.post('/api/projects/'+p.id,p)).status,200);
  const plan=await(await fetch(h.url+`/api/projects/${p.id}/plan`)).json();assert.equal(plan[0].size,'1024x576');assert.equal(plan[0].video.frames,73);
  await h.post('/api/batch-queue/pause',{paused:true});
  const batch=await h.post(`/api/projects/${p.id}/batch`,{requestId:randomUUID(),kind:'image',shotIds:[p.shots[0].id]});assert.equal(batch.status,201);
  const item=(await batch.json())[0];assert.equal(item.input.size,'1024x576');assert.match(item.input.prompt,/人物在右侧/);assert.equal(item.frameSignature,plan[0].frameSignature);assert.equal(item.productionSnapshot.production.style,'雨夜动画');
  p.production.style='不同风格';assert.equal(item.productionSnapshot.production.style,'雨夜动画');
});

test('deleting a project permanently removes its generated media and keeps independent shared assets and other projects',async t=>{
  const h=await harness(t),project=await threeShotProject(h);
  const other=await(await h.post('/api/projects',{name:'Keep this project'})).json();
  const jobId=randomUUID(),exportId=randomUUID(),archiveId=randomUUID();
  const media=resolve(h.temp,'missing/output/aigc-studio/keep.mp4');await mkdir(resolve(media,'..'),{recursive:true});await writeFile(media,'original video');
  h.app.state.jobs.push({id:jobId,projectId:project.id,status:'success',outputs:[{type:'output',kind:'video',filename:'keep.mp4',subfolder:'aigc-studio'}]});
  h.app.state.batchQueue.push({id:jobId,projectId:project.id,status:'success'});
  h.app.state.exports.push({id:exportId,projectId:project.id,status:'success'});
  h.app.state.archives.push({id:archiveId,projectId:project.id});
  const kept=structuredClone({jobs:h.app.state.jobs,assets:h.app.state.assets,uploads:h.app.state.uploads,exports:h.app.state.exports,archives:h.app.state.archives});
  const response=await fetch(h.url+'/api/projects/'+project.id,{method:'DELETE',headers:{'Content-Type':'application/json'}});
  assert.equal(response.status,200);
  assert.deepEqual((await(await fetch(h.url+'/api/projects')).json()).map(p=>p.id),[other.id]);
  assert.equal((await fetch(h.url+'/api/projects/'+project.id)).status,404);
  assert.ok(!h.app.state.batchQueue.some(q=>q.projectId===project.id));
  assert.ok(h.app.state.jobs.find(j=>j.id===jobId).deletedAt);
  assert.deepEqual(h.app.state.assets,kept.assets);assert.deepEqual(h.app.state.uploads,kept.uploads);
  await assert.rejects(readFile(media),e=>e.code==='ENOENT');
  const stored=JSON.parse(await readFile(resolve(h.temp,'data/state.json'),'utf8'));assert.deepEqual(stored.projects.map(p=>p.id),[other.id]);
  assert.equal((await fetch(h.url+'/api/projects/'+project.id,{method:'DELETE',headers:{'Content-Type':'application/json'}})).status,404);
  assert.equal((await fetch(h.url+'/api/projects/'+other.id,{method:'DELETE',headers:{'Content-Type':'application/json'}})).status,200);
  assert.deepEqual(await(await fetch(h.url+'/api/projects')).json(),[]);
});

test('project deletion rejects pending generation and running exports without changing the project',async t=>{
  const h=await harness(t),project=await threeShotProject(h);
  await h.post('/api/batch-queue/pause',{paused:true});
  const remove=()=>fetch(h.url+'/api/projects/'+project.id,{method:'DELETE',headers:{'Content-Type':'application/json'}});
  h.app.state.batchQueue.push({id:randomUUID(),projectId:project.id,status:'waiting'});
  assert.equal((await remove()).status,409);h.app.state.batchQueue.length=0;
  h.app.state.jobs.push({id:randomUUID(),projectId:project.id,status:'recovering'});
  assert.equal((await remove()).status,409);h.app.state.jobs.length=0;
  h.app.state.exports.push({id:randomUUID(),projectId:project.id,status:'running'});
  assert.equal((await remove()).status,409);
  assert.ok(h.app.state.projects.some(p=>p.id===project.id));
  assert.equal((await remove()).status,409);
});

test('deleting a work permanently removes its file and project references',async t=>{
  const h=await harness(t),project=await threeShotProject(h),id=randomUUID();
  const path=resolve(h.temp,'missing/output/aigc-studio/retained.png');await mkdir(resolve(path,'..'),{recursive:true});await writeFile(path,'retained image');
  h.app.state.jobs.push({id,projectId:project.id,section:'image',status:'success',images:[],outputs:[{index:0,kind:'image',type:'output',filename:'retained.png',subfolder:'aigc-studio'}]});
  const shot=h.app.state.projects[0].shots[0];shot.imageHistory=[id];shot.imageJobId=id;shot.confirmedFrameJobId=id;
  const remove=()=>fetch(h.url+'/api/jobs/'+id,{method:'DELETE',headers:{'Content-Type':'application/json'}});
  assert.equal((await remove()).status,200);const deletedAt=h.app.state.jobs[0].deletedAt;assert.ok(deletedAt);
  assert.deepEqual(await(await fetch(h.url+'/api/jobs')).json(),[]);
  const snapshot=await(await fetch(h.url+'/api/projects/'+project.id)).json();assert.equal(snapshot.jobs[0].id,id);assert.equal(snapshot.project.shots[0].confirmedFrameJobId,null);
  await assert.rejects(readFile(path),e=>e.code==='ENOENT');
  assert.equal((await remove()).status,200);assert.equal(h.app.state.jobs[0].deletedAt,deletedAt);
  const stored=JSON.parse(await readFile(resolve(h.temp,'data/state.json'),'utf8'));assert.equal(stored.jobs[0].deletedAt,deletedAt);assert.equal(stored.projects[0].shots[0].imageJobId,null);
  for(const status of ['failed','cancelled']){const other=randomUUID();h.app.state.jobs.push({id:other,status,images:[],outputs:[]});assert.equal((await fetch(h.url+'/api/jobs/'+other,{method:'DELETE',headers:{'Content-Type':'application/json'}})).status,200);}
  assert.deepEqual(await(await fetch(h.url+'/api/jobs')).json(),[]);
});

test('work deletion rejects active tasks and foreign origins without interrupting the engine',async t=>{
  const h=await harness(t);
  for(const status of ['submitting','queued','running','recovering']){const id=randomUUID();h.app.state.jobs.push({id,status,images:[],outputs:[]});assert.equal((await fetch(h.url+'/api/jobs/'+id,{method:'DELETE',headers:{'Content-Type':'application/json'}})).status,409);assert.equal(h.app.state.jobs.find(j=>j.id===id).deletedAt,undefined);}
  const id=randomUUID();h.app.state.jobs.push({id,status:'failed',images:[],outputs:[]});assert.equal((await fetch(h.url+'/api/jobs/'+id,{method:'DELETE',headers:{'Content-Type':'application/json',Origin:'https://example.com'}})).status,403);
  assert.equal((await fetch(h.url+'/api/jobs/'+randomUUID(),{method:'DELETE',headers:{'Content-Type':'application/json'}})).status,404);assert.deepEqual(h.engine.cancelled,[]);
});

test('bulk deletion clears selected files and versions while keeping unselected works',async t=>{
  const h=await harness(t),project=await threeShotProject(h);
  const records=['success','failed','cancelled','success'].map(status=>({id:randomUUID(),projectId:project.id,status,section:'image',images:[],outputs:[]}));
  const file=resolve(h.temp,'missing/output/aigc-studio/keep.png');await mkdir(resolve(file,'..'),{recursive:true});await writeFile(file,'retained output');
  records[0].outputs=[{index:0,kind:'image',filename:'keep.png',subfolder:'aigc-studio',type:'output'}];h.app.state.jobs.push(...records);
  const shot=h.app.state.projects[0].shots[0];shot.imageHistory=[records[0].id];shot.imageJobId=records[0].id;shot.confirmedFrameJobId=records[0].id;
  const ids=records.slice(0,3).map(j=>j.id),response=await h.post('/api/jobs/delete',{jobIds:ids});assert.equal(response.status,200);assert.deepEqual((await response.json()).deletedIds,ids);
  const date=records[0].deletedAt;assert.ok(date);assert.ok(records.slice(0,3).every(j=>j.deletedAt===date));assert.equal(records[3].deletedAt,undefined);
  assert.deepEqual((await(await fetch(h.url+'/api/jobs')).json()).map(j=>j.id),[records[3].id]);
  const snapshot=await(await fetch(h.url+'/api/projects/'+project.id)).json();assert.equal(snapshot.project.shots[0].confirmedFrameJobId,null);assert.equal(snapshot.jobs.length,4);await assert.rejects(readFile(file),e=>e.code==='ENOENT');
  assert.equal((await h.post('/api/jobs/delete',{jobIds:ids})).status,200);assert.equal(records[0].deletedAt,date);
  const stored=JSON.parse(await readFile(resolve(h.temp,'data/state.json'),'utf8'));assert.equal(stored.jobs.filter(j=>j.deletedAt).length,3);assert.equal(stored.projects[0].shots[0].imageJobId,null);
});

test('bulk deletion rejects any active or missing record atomically and never interrupts generation',async t=>{
  const h=await harness(t);const done={id:randomUUID(),status:'success',images:[],outputs:[]};h.app.state.jobs.push(done);
  for(const status of ['submitting','queued','running','recovering']){
    const job={id:randomUUID(),status,images:[],outputs:[]};h.app.state.jobs.push(job);
    const r=await h.post('/api/jobs/delete',{jobIds:[done.id,job.id]});assert.equal(r.status,409);assert.equal(done.deletedAt,undefined);assert.equal(job.deletedAt,undefined);
  }
  assert.equal((await h.post('/api/jobs/delete',{jobIds:[done.id,randomUUID()]})).status,404);assert.equal(done.deletedAt,undefined);assert.deepEqual(h.engine.cancelled,[]);
});

test('bulk deletion rejects malformed, empty, duplicate and foreign-origin requests without deleting anything',async t=>{
  const h=await harness(t);const job={id:randomUUID(),status:'failed',images:[],outputs:[]};h.app.state.jobs.push(job);
  for(const body of [null,{}, {jobIds:[]},{jobIds:'all'},{jobIds:[null]},{jobIds:[job.id,job.id]}])assert.equal((await h.post('/api/jobs/delete',body)).status,400);
  assert.equal((await h.post('/api/jobs/delete',{jobIds:[job.id]},{Origin:'https://example.com'})).status,403);assert.equal(job.deletedAt,undefined);
});

test('six, ten and twenty combined project references enqueue intact; twenty-one are rejected atomically',async t=>{
  const h=await harness(t),project=await threeShotProject(h),pool=[h.app.state.assets[0]];
  for(let i=1;i<21;i++){const upload=await h.upload();pool.push(await(await h.post('/api/assets',{name:'Ref '+i,category:i<3?'character':'scene',uploadId:upload.id})).json());}
  project.characters=[{id:randomUUID(),name:'Main role',description:'Keep identity',referenceIds:pool.slice(0,3).map(a=>a.id)}];
  for(const shot of project.shots){shot.referenceIds=[];shot.characterIds=[project.characters[0].id];}
  project.production={referenceIds:pool.slice(3,6).map(a=>a.id)};
  await h.post('/api/batch-queue/pause',{paused:true});
  for(const count of [6,10,20]){
    project.production.referenceIds=pool.slice(3,count).map(a=>a.id);assert.equal((await h.post('/api/projects/'+project.id,project)).status,200);
    const response=await h.post('/api/projects/'+project.id+'/batch',{requestId:randomUUID(),kind:'image',shotIds:[project.shots[0].id]});assert.equal(response.status,201);
    const [item]=await response.json();assert.equal(item.input.template,'flux-multi');assert.deepEqual(item.input.images,pool.slice(0,count).map(a=>a.uploadId));assert.equal(item.productionSnapshot.references.length,count);
    await h.post('/api/batch-queue/'+item.id+'/cancel',{});
  }
  project.shots[0].referenceIds=[pool[20].id];assert.equal((await h.post('/api/projects/'+project.id,project)).status,200);const before=h.app.state.batchQueue.length;
  const rejected=await h.post('/api/projects/'+project.id+'/batch',{requestId:randomUUID(),kind:'image',shotIds:[project.shots[0].id]});assert.equal(rejected.status,400);assert.match((await rejected.json()).error,/20/);assert.equal(h.app.state.batchQueue.length,before);
});
