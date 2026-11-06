import { randomUUID } from 'node:crypto';
import { resolve, sep } from 'node:path';
import { mkdirSync, writeFileSync, existsSync, statSync, createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { normalizeVideoOptions } from './public/video-options.js';
import { validateCharacters, characterContext } from './characters.mjs';
import { primaryOutput, requireMedia } from './media.mjs';
import {uploadFile} from './uploads.mjs';
import { normalizeDirector, normalizeProduction } from './public/director-options.js';
import { shotPlan, frameMatches, videoMatches, validateEdit } from './production.mjs';

const active = new Set(['submitting', 'queued', 'running', 'recovering']);
const pending = item => ['waiting', 'dispatched'].includes(item.status);
function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function text(value, limit = 6000) { return String(value ?? '').trim().slice(0, limit); }
export function createProjects({ state, save, submitJob, refresh, json, upstream, publicJob, config, appRoot, dataRoot, send, readBody, isEnhancing=()=>false,removeProject }) {
  state.projects ??= [];
  state.assets ??= [];
  state.batchQueue ??= [];
  state.exports ??= [];
  state.queuePaused ??= false;
  for (const item of state.exports) if (item.status === 'running') { item.status = 'failed'; item.error = '创作台上次退出时拼接未完成，请重新导出。'; }
  let ticking = false;
  let exporting = false;
  const tailProjects = new Set();
  const projectById = id => state.projects.find(project => project.id === id) ?? fail('项目不存在。', 404);
  const jobById = id => state.jobs.find(job => job.id === id);
  const shotBusy = (pid, sid) => state.batchQueue.some(item => item.projectId === pid && item.shotId === sid && pending(item));
  const projectBusy = pid => state.batchQueue.some(item => item.projectId === pid && pending(item));
  function imageJob(id) {
    const job = jobById(id);
    if (!job || job.deletedAt || job.status !== 'success' || primaryOutput(job)?.kind !== 'image') fail('请先选择生成成功的首帧。');
    requireMedia(config, primaryOutput(job));
    return job;
  }
  function currentVideo(shot, project) {
    const job = jobById(shot.videoJobId);
    return videoMatches(project, shot, job, state.assets) ? job : null;
  }
  function updateItems() {
    let changed = false;
    for (const item of state.batchQueue.filter(item => item.status === 'dispatched')) {
      const job = jobById(item.id);
      if (job && !active.has(job.status)) { item.status = job.status; item.error = job.error; if (job.status === 'failed') state.queuePaused = true; if(job.status!=='success')cancelDependents(item.id); changed = true; }
    }
    if (changed) save();
  }
  function cancelDependents(id) {
    for(const item of state.batchQueue.filter(q=>q.dependsOnId===id&&q.status==='waiting')){item.status='cancelled';item.error='前置首帧未完成，已取消自动生成视频；可以重新一键生成。';}
  }
  async function uploadFrame(job) {
    const file=primaryOutput(job);requireMedia(config,file);
    const existing=Object.entries(state.uploads).find(([id,u])=>u.file?.type===file.type&&u.file?.filename===file.filename&&u.file?.subfolder===file.subfolder);
    if(existing)return existing[0];
    const id=randomUUID();state.uploads[id]={name:[file.subfolder,file.filename].filter(Boolean).join('/'),file:{type:file.type,subfolder:file.subfolder,filename:file.filename},type:'image/png',sourceJobId:job.id};save();return id;
  }
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      await refresh(); updateItems();
      if (state.queuePaused || exporting || isEnhancing() || state.jobs.some(job => active.has(job.status))) return;
      const item = state.batchQueue.find(item => item.status === 'waiting');
      if (!item) return;
      const queue = await json('/queue');
      if (queue.queue_running.length || queue.queue_pending.length) return;
      const project = projectById(item.projectId);
      const shot = project.shots.find(shot => shot.id === item.shotId);
      try {
        const existing = jobById(item.id);
        let job = existing;
        if (!job) {
          const input = { ...item.input, requestId: item.id };
          if (item.kind === 'video') {
            const frame=imageJob(item.frameJobId);
            if(item.autoConfirmFrame){if(!frameMatches(project,shot,frame,state.assets))fail('自动生成的首帧与当前镜头设定不匹配，请重新生成。');shot.confirmedFrameJobId=frame.id;}
            input.images = [...(input.template==='h3-reference'?input.images:[]),await uploadFrame(frame)];
          }
          job = await submitJob(input, { projectId: project.id, shotId: shot.id, frameJobId: item.frameJobId, characterSignature: item.characterSignature, frameSignature: item.frameSignature, videoSignature: item.videoSignature, productionSnapshot: item.productionSnapshot });
        }
        item.status = 'dispatched';
        const history = item.kind === 'image' ? shot.imageHistory : shot.videoHistory;
        if (!history.includes(job.id)) history.push(job.id);
        if (item.kind === 'image') { shot.imageJobId = job.id; shot.confirmedFrameJobId = null; }
        else {shot.videoJobId = job.id;if(item.autoConfirmFrame)shot.edit=validateEdit({},job);}
        updateItems();
      } catch (error) {
        if (error.status === 409 || error.status === 503) return;
        item.status = 'failed'; item.error = error.message;
        cancelDependents(item.id);
        state.queuePaused = true;
      }
      save();
    } catch { /* Engine unavailable: keep pending items and retry on the next tick. */ }
    finally { ticking = false; }
  }
  async function enqueue(project, body) {
    const requestedKind = body.kind;
    if (!['image', 'video', 'both'].includes(requestedKind)) fail('请选择首帧、视频或一键生成。');
    const batchId = body.requestId;
    if (typeof batchId !== 'string' || !/^[a-f0-9-]{36}$/.test(batchId)) fail('批次编号无效。');
    const duplicate = state.batchQueue.filter(item => item.batchId === batchId);
    if (duplicate.length) return duplicate;
    const ids = body.shotIds;
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) fail('请选择镜头。');
    const shots = ids.map(id => project.shots.find(shot => shot.id === id) ?? fail('镜头不存在。'));
    const items = [];
    for (const shot of shots) {
      if (shotBusy(project.id, shot.id)) fail('选中的镜头已有排队或运行任务。', 409);
      const newFrameId=requestedKind==='both'?randomUUID():null;
      for(const kind of requestedKind==='both'?['image','video']:[requestedKind]){
      let input;
      let frameJobId;
      const character = characterContext(project, shot);
      const plan = shotPlan(project,kind==='video'&&newFrameId?{...shot,confirmedFrameJobId:newFrameId}:shot,state.assets);
      if (plan.errors.length) fail(`镜头「${shot.title}」：${plan.errors.join('；')}`);
      if (kind === 'image') {
        const assets = plan.referenceIds.map(id => state.assets.find(asset => asset.id === id) ?? fail('参考素材已不存在。'));
        if (assets.length > 20) fail(`镜头「${shot.title}」的全部参考合计超过 20 张，请减少参考图。`);
        input = { template: assets.length > 3 ? 'flux-multi' : ['z-image','flux-edit','flux-2ref','flux-3ref'][assets.length], prompt: plan.imagePrompt, images: assets.map(asset => asset.uploadId), seed: shot.seed, size: plan.size };
        for (const asset of assets) { const upload=state.uploads[asset.uploadId]; if(!upload) fail('参考图上传记录缺失。'); requireMedia(config,uploadFile(upload)); }
      } else {
        if (project.videoTemplate === 'h3-reference' && plan.referenceIds.length > 3) fail('Ref2VA 实验视频最多使用 3 张资产参考加 1 张分镜图；20 张参考目前用于首帧生成。');
        if(newFrameId)frameJobId=newFrameId;
        else{
          const frame = imageJob(shot.confirmedFrameJobId);
          if (character.signature && frame.characterSignature !== character.signature) fail(`镜头「${shot.title}」角色设定已变化，请先重做并确认使用当前角色参考的首帧。`);
          if (!frameMatches(project, shot, frame, state.assets)) fail(`镜头「${shot.title}」画面设定已变化，请重做并确认首帧。`);
          frameJobId = frame.id;
        }
        const images=project.videoTemplate==='h3-reference'?plan.refs.map(a=>a.uploadId):[];
        input = { template: project.videoTemplate, prompt: plan.videoPrompt, images, seed: shot.seed, size: '512x512', video: { ...plan.video, camera: 'none', action: 'none', shot: 'none', style: 'preserve', pace: 'none' } };
      }
      if (input.prompt.length > 6000) fail(`镜头「${shot.title}」合并后的描述超过 6000 字。`);
      items.push({ id: kind==='image'&&newFrameId?newFrameId:randomUUID(), batchId, projectId: project.id, shotId: shot.id, kind, frameJobId, ...(kind==='video'&&newFrameId?{dependsOnId:newFrameId,autoConfirmFrame:true}:{}), characterSignature: character.signature, frameSignature: plan.frameSignature, videoSignature: plan.videoSignature, productionSnapshot: { production: structuredClone(project.production||{}), director: structuredClone(shot.director||{}), generalPrompt:shot.generalPrompt||undefined, references: plan.refs.map(a=>({id:a.id,name:a.name,uploadId:a.uploadId})), imagePrompt: plan.imagePrompt, videoPrompt: plan.videoPrompt, size: plan.size, videoTemplate: project.videoTemplate }, input, status: 'waiting', createdAt: new Date().toISOString() });
      }
    }
    state.batchQueue.push(...items); save();
    return items;
  }
  function localVideo(job) {
    const file = primaryOutput(job);
    const base = resolve(config.comfyRoot, 'output');
    const path = resolve(base, file.subfolder, file.filename);
    if (!path.startsWith(base + sep) || file.type !== 'output' || !existsSync(path)) fail('本地视频文件缺失，请检查 ComfyUI 输出目录。');
    return path;
  }
  async function usePreviousTail(project, body) {
    if (projectBusy(project.id)) fail('请等待项目队列完成或取消待处理项，再替换首帧。', 409);
    const index = project.shots.findIndex(shot => shot.id === body.shotId);
    if (index < 0) fail('镜头不存在。', 404);
    if (index === 0) fail('第一镜头没有上一段视频。');
    const previous = project.shots[index - 1];
    const shot = project.shots[index];
    const source = currentVideo(previous, project) ?? fail('请先完成上一镜头的视频，并选中与当前角色设定及确认首帧对应的成功版本。');
    const signature = characterContext(project, shot).signature;
    if (signature && source.characterSignature !== signature) fail('本镜头出场角色与上一段不同，请使用固定角色参考生成独立首帧。');
    const input = localVideo(source);
    let frameJob = shot.imageHistory.map(jobById).find(job => job?.status === 'success' && job.sourceVideoJobId === source.id && existsSync(resolve(config.comfyRoot, 'output', job.outputs[0].subfolder, job.outputs[0].filename)));
    tailProjects.add(project.id);
    try {
      if (!frameJob) {
        const python = config.pythonPath || resolve(config.comfyRoot, '../python_embeded/python.exe');
        if (!existsSync(python)) fail('未找到用于提取尾帧的 ComfyUI Python 环境。');
        const id = randomUUID();
        const filename = id + '_last-frame.png';
        const output = resolve(config.comfyRoot, 'output/aigc-studio', filename);
        const metadata = await new Promise((ok, reject) => {
          const child = spawn(python, ['-s', resolve(appRoot, 'extract-last-frame.py'), input, output], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
          let text = ''; let errors = '';
          child.stdout.on('data', bytes => { text += bytes.toString(); });
          child.stderr.on('data', bytes => { errors = (errors + bytes.toString()).slice(-3000); });
          child.on('error', reject);
          child.on('close', code => {
            if (code !== 0 || !existsSync(output)) return reject(Object.assign(Error(errors || '尾帧提取失败，请检查视频文件。'), { status: 400 }));
            try { ok(JSON.parse(text.trim())); } catch { reject(Error('无法读取尾帧提取结果。')); }
          });
        });
        const now = new Date().toISOString();
        frameJob = { id, template: 'video-last-frame', title: '上一段视频尾帧', section: 'image', status: 'success', projectId: project.id, shotId: shot.id, sourceShotId: previous.id, sourceVideoJobId: source.id, sourceFrameIndex: metadata.sourceFrameIndex, sourceFrames: metadata.sourceFrames, prompt: '使用上一段视频的最后一帧作为本镜头首帧。', images: [], size: `${metadata.width}x${metadata.height}`, createdAt: now, finishedAt: now, outputs: [{ index: 0, kind: 'image', type: 'output', subfolder: 'aigc-studio', filename, metadata: { kind: 'image', width: metadata.width, height: metadata.height } }] };
        state.jobs.unshift(frameJob);
      }
      frameJob.characterSignature = source.characterSignature;
      frameJob.frameSignature = shotPlan(project,shot,state.assets).frameSignature;
      if (!shot.imageHistory.includes(frameJob.id)) shot.imageHistory.push(frameJob.id);
      shot.imageJobId = frameJob.id;
      shot.confirmedFrameJobId = frameJob.id;
      save();
      return { shot, frame: publicJob(frameJob), sourceVideoJobId: source.id };
    } finally { tailProjects.delete(project.id); }
  }
  function startExport(project) {
    if (exporting || isEnhancing() || state.jobs.some(job => active.has(job.status)) || state.batchQueue.some(pending)) fail('请先完成或取消队列中的任务，再拼接导出。', 409);
    if (!project.shots.length) fail('项目中还没有镜头。');
    const videos = project.shots.map(shot => currentVideo(shot, project) ?? fail(`镜头「${shot.title}」还没有与当前角色及确认首帧对应的成功视频。`));
    const paths = videos.map(localVideo);
    const python = config.pythonPath || resolve(config.comfyRoot, '../python_embeded/python.exe');
    if (!existsSync(python)) fail('没有找到用于拼接的 ComfyUI Python 环境。');
    const id = randomUUID();
    const folder = resolve(dataRoot, 'exports'); mkdirSync(folder, { recursive: true });
    const manifest = resolve(folder, id + '.json');
    const output = resolve(folder, id + '.mp4');
    const clips=videos.map((job,index)=>({path:paths[index],...validateEdit(project.shots[index].edit,job)}));
    const render={clips};
    if(project.production){const [width,height]=project.production.exportSize.split('x').map(Number);render.canvas={width,height,fps:24};}
    if(project.production?.backgroundAudioId){const audio=state.audioAssets?.find(a=>a.id===project.production.backgroundAudioId);if(!audio)fail('背景音已不存在，请重新选择。');const audioPath=audio.storagePath||resolve(dataRoot,'audio',audio.filename);if(!existsSync(audioPath))fail('背景声音文件缺失。');render.background={path:audioPath,gain:project.production.backgroundGain};}
    writeFileSync(manifest, JSON.stringify(render));
    const item = { id, projectId: project.id, title: project.name, status: 'running', jobIds: videos.map(job => job.id), createdAt: new Date().toISOString(), completed: 0, total: paths.length };
    state.exports.unshift(item); exporting = true; save();
    const child = spawn(python, ['-s', resolve(appRoot, 'concat.py'), manifest, output], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; let buffer = '';
    child.stderr.on('data', bytes => { log = (log + bytes.toString()).slice(-12000); });
    child.stdout.on('data', bytes => {
      buffer += bytes.toString();
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) {
        try { const progress = JSON.parse(line); if (progress.frames) item.metadata = progress; else item.completed = progress.completed; } catch { /* Keep non-JSON diagnostics in stderr. */ }
      }
      save();
    });
    child.on('error', error => { item.status = 'failed'; item.error = error.message; exporting = false; save(); });
    child.on('close', code => { item.status = code === 0 && existsSync(output) ? 'success' : 'failed'; item.error = item.status === 'failed' ? log || '拼接进程未成功结束。' : null; item.finishedAt = new Date().toISOString(); exporting = false; save(); });
    return item;
  }
  async function handle(req, res, url) {
    if (!/^\/api\/(projects|assets|batch-queue|exports)(\/|$)/.test(url.pathname)) return false;
    updateItems();
    const parts = url.pathname.split('/').filter(Boolean);
    if (req.method === 'POST' && parts[1] === 'projects' && tailProjects.has(parts[2])) fail('正在提取该项目的尾帧，请稍候。', 409);
    const body = req.method === 'POST' ? JSON.parse((await readBody(req)).toString('utf8')) : null;
    let result;
    let status = 200;
    if (parts[1] === 'assets') {
      if (req.method === 'GET') result = state.assets;
      else if (req.method === 'POST') {
        if (!state.uploads[body.uploadId]) fail('素材图片不存在。');
        if (!['character', 'scene', 'prop', 'style'].includes(body.category)) fail('请选择素材分类。');
        if (!text(body.name, 80)) fail('请填写素材名称。');
        result = { id: randomUUID(), name: text(body.name, 80), category: body.category, uploadId: body.uploadId };
        state.assets.push(result); status = 201; save();
      } else fail('接口不存在。', 404);
    } else if (parts[1] === 'batch-queue') {
      if (req.method === 'GET') result = { paused: state.queuePaused, items: state.batchQueue };
      else if (parts[2] === 'pause' && req.method === 'POST') { state.queuePaused = Boolean(body.paused); save(); result = { paused: state.queuePaused }; }
      else if (parts[3] === 'cancel' && req.method === 'POST') {
        const item = state.batchQueue.find(item => item.id === parts[2]);
        if (!item || item.status !== 'waiting') fail('此项已开始或已经结束；运行中的任务请使用停止按钮。');
        item.status = 'cancelled'; cancelDependents(item.id); save(); result = item;
      } else fail('接口不存在。', 404);
    } else if (parts[1] === 'exports') {
      const item = state.exports.find(item => item.id === parts[2]) ?? fail('导出记录不存在。', 404);
      if (parts[3] !== 'file' || req.method !== 'GET' || item.status !== 'success') fail('成片还未导出成功。');
      const path = item.storagePath || resolve(dataRoot, 'exports', item.id + '.mp4');
      const size = statSync(path).size;
      let start = 0; let end = size - 1; let code = 200;
      if (req.headers.range) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
        if (!match) fail('不支持的读取范围。', 416);
        start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), end) : end;
        if (start > end || start >= size) fail('读取范围超出文件。', 416);
        code = 206;
      }
      const headers = { 'Content-Type': 'video/mp4', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' };
      if (code === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      if (url.searchParams.has('download')) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(item.title + '.mp4')}`;
      res.writeHead(code, headers);
      const stream = createReadStream(path, { start, end }); stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res); return true;
    } else if (parts[1] === 'projects') {
      if (parts.length === 2) {
        if (req.method === 'GET') result = state.projects;
        else if (req.method === 'POST') {
          if (!text(body.name, 80)) fail('请填写项目名称。');
          result = { id: randomUUID(), name: text(body.name, 80), script: '', videoTemplate: 'h3-fast', shots: [], createdAt: new Date().toISOString() };
          if(body.production){try{result.production=normalizeProduction(body.production,state.assets);result.video=normalizeVideoOptions({aspect:'landscape'});}catch(error){fail(error.message);}}
          state.projects.push(result); save(); status = 201;
        } else fail('接口不存在。', 404);
      } else {
        const project = projectById(parts[2]);
        if (parts.length === 3 && req.method === 'GET') result = { project, assets:state.assets, ref2vaEnabled:Boolean(config.enableRef2VA), plans: project.shots.map(shot=>shotPlan(project,shot,state.assets)), archives:(state.archives||[]).filter(a=>a.projectId===project.id), characterSignatures: Object.fromEntries(project.shots.map(shot => [shot.id, characterContext(project, shot).signature])), jobs: state.jobs.filter(job => job.projectId === project.id).map(publicJob), queue: state.batchQueue.filter(item => item.projectId === project.id), paused: state.queuePaused, exports: state.exports.filter(item => item.projectId === project.id) };
        else if (parts.length === 3 && req.method === 'DELETE') {
          if (projectBusy(project.id) || tailProjects.size || isEnhancing() || state.batchQueue.some(pending) || state.jobs.some(job => active.has(job.status)) || state.exports.some(item => item.status === 'running')) fail('正在生成、排队、提取尾帧或导出，请等待完成或取消待处理项后再删除项目。', 409);
          if(!removeProject)fail('永久删除功能尚未初始化。');removeProject(project.id);
          save(); result = { deleted: true, id: project.id };
        }
        else if (parts.length === 3 && req.method === 'POST') {
          if (projectBusy(project.id)) fail('请先暂停并取消该项目的待处理项，或等待生成结束后再编辑。', 409);
          if (!text(body.name, 80)) fail('请填写项目名称。');
          if (!['h3-fast', 'h3-base',...(config.enableRef2VA?['h3-reference']:[])].includes(body.videoTemplate)) fail('视频模板无效。');
          let video;
          try { video = normalizeVideoOptions(body.video); } catch (error) { fail(error.message); }
          const characters = validateCharacters(body.characters ?? project.characters ?? [], state.assets);
          let production;
          if(body.production??project.production){try{production=normalizeProduction(body.production??project.production,state.assets);}catch(error){fail(error.message);}}
          if (!Array.isArray(body.shots) || body.shots.length > 50) fail('镜头数量最多为 50。');
          const ids = new Set();
          const next = body.shots.map((entry, i) => {
            if (!/^[a-f0-9-]{36}$/.test(entry.id) || ids.has(entry.id)) fail('镜头编号无效或重复。'); ids.add(entry.id);
            const old = project.shots.find(shot => shot.id === entry.id);
            const seed = entry.seed === '' || entry.seed == null ? '' : Number(entry.seed);
            if (seed !== '' && (!Number.isSafeInteger(seed) || seed < 0)) fail('镜头种子必须是非负安全整数。');
            if (!Array.isArray(entry.referenceIds) || entry.referenceIds.length > 20 || entry.referenceIds.some(id => !state.assets.some(asset => asset.id === id))) fail('参考素材无效，最多选择二十张。');
            const characterIds = entry.characterIds ?? characters.map(item => item.id);
            if (!Array.isArray(characterIds) || new Set(characterIds).size !== characterIds.length || characterIds.some(id => !characters.some(item => item.id === id))) fail('镜头出场角色无效。');
            let director;
            if(entry.director??old?.director){try{director=normalizeDirector(entry.director??old.director);}catch(error){fail(error.message);}}
            const frames=entry.frames?Number(entry.frames):null;if(frames){try{normalizeVideoOptions({frames});}catch(error){fail(error.message);}}
            const result={ ...(old ?? { imageHistory: [], videoHistory: [] }), id: entry.id, title: text(entry.title, 80) || `镜头 ${i + 1}`, imagePrompt: text(entry.imagePrompt), videoPrompt: text(entry.videoPrompt), seed, referenceIds: [...new Set(entry.referenceIds)], characterIds, frames, inheritReferences: entry.inheritReferences!==false };
            if(entry.generalPrompt!==undefined||old?.generalPrompt!==undefined){const value=String(entry.generalPrompt??old?.generalPrompt??'').trim();if(value.length>6000)fail('总提示词不超过 6000 字。');result.generalPrompt=value;}
            if(director)result.director=director;
            if(entry.edit){try{result.edit=validateEdit(entry.edit,jobById(old?.videoJobId));}catch(error){fail(error.message);}}
            return result;
          });
          project.name = text(body.name, 80); project.script = text(body.script, 30000); project.videoTemplate = body.videoTemplate;
          project.video = video;
          project.characters = characters;
          if(production)project.production=production;
          project.shots = next; save(); result = project;
        } else if (parts[3] === 'plan' && req.method === 'GET') { result = project.shots.map(shot=>shotPlan(project,shot,state.assets)); }
        else if (parts[3] === 'use-previous-tail' && parts.length === 4 && req.method === 'POST') { result = await usePreviousTail(project, body); }
        else if (parts[3] === 'batch' && req.method === 'POST') { result = await enqueue(project, body); status = 201; }
        else if (parts[3] === 'select' && req.method === 'POST') {
          const shot = project.shots.find(shot => shot.id === body.shotId) ?? fail('镜头不存在。');
          if (shotBusy(project.id, shot.id)) fail('请等待该镜头任务结束。', 409);
          if (!['image', 'video'].includes(body.kind)) fail('版本类别无效。');
          const history = body.kind === 'image' ? shot.imageHistory : shot.videoHistory;
          const job = jobById(body.jobId);
          if (!history.includes(body.jobId) || job?.status !== 'success') fail('此版本不可用。');
          const signature = characterContext(project, shot).signature;
          if (signature && job.characterSignature !== signature) fail('该版本来自旧角色设定，请重做首帧或选择当前设定对应的版本。');
          const plan=shotPlan(project,shot,state.assets);
          if(body.kind==='image'&&plan.frameSignature&&job.frameSignature!==plan.frameSignature)fail('该首帧来自旧画面设定，请重做或恢复对应设定。');
          if(body.kind==='video'&&!videoMatches(project,shot,job,state.assets))fail('该视频与当前首帧或镜头设定不匹配。');
          if (body.kind === 'image') { shot.imageJobId = job.id; shot.confirmedFrameJobId = job.id; }
          else { if(shot.videoJobId!==job.id)shot.edit=validateEdit({gain:shot.edit?.gain,mute:shot.edit?.mute,notes:shot.edit?.notes},job); shot.videoJobId = job.id; }
          save(); result = shot;
        } else if (parts[3] === 'export' && req.method === 'POST') { result = startExport(project); status = 201; }
        else fail('接口不存在。', 404);
      }
    }
    send(res, status, result); return true;
  }
  return { handle, tick, isExporting: () => exporting };
}
