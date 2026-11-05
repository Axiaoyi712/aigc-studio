import http from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { templates, parseRequest, compileGraph, checkGraph, loadGraph } from './workflows.mjs';
import { createProjects } from './projects.mjs';
import { createPromptLibrary } from './prompt-library.mjs';
import { primaryOutput, localMedia } from './media.mjs';
import { createProjectFiles } from './project-files.mjs';
import { createAssistant } from './assistant.mjs';
import { createStorage } from './storage.mjs';
import { createUpscaler } from './upscale.mjs';
import { createDrivers } from './drivers.mjs';
import {createMediaLifecycle} from './media-lifecycle.mjs';
import {uploadFile} from './uploads.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const activeStates = new Set(['submitting', 'queued', 'running', 'recovering']);
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

function fault(message, status = 400) { return Object.assign(new Error(message), { status }); }
function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function readBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw fault('文件过大，图片上限为 20MB。', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createStudio(config, { appRoot = root, dataRoot = resolve(appRoot, 'data'), websocket = true } = {}) {
  mkdirSync(dataRoot, { recursive: true });
  const statePath = resolve(dataRoot, 'state.json');
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { jobs: [], uploads: {} };
  const storage = createStorage(config,state,dataRoot);
  const save = () => { storage.sync(); writeFileSync(statePath + '.tmp', JSON.stringify(state, null, 2)); renameSync(statePath + '.tmp', statePath); };
  const lifecycle=createMediaLifecycle({state,config,dataRoot,storage});
  let submitting = false;
  let updating = false;
  let ws;
  let wsUrl;
  let infoCache;
  let infoUrl;
  let infoLoadedAt=0;
  let closed = false;
  const clientId = randomUUID();

  function engineUrl() {
    let value = config.comfyUrl;
    const records = [];
    for (const path of [resolve(dataRoot, 'comfy-server.json'), resolve(config.comfyRoot, '../.launcher/port-check/last-start.json')]) {
      if (!existsSync(path)) continue;
      try { records.push(JSON.parse(readFileSync(path, 'utf8'))); } catch { /* A partial launcher write is retried on the next request. */ }
    }
    records.sort((a, b) => (Date.parse(b.CheckedAt) || 0) - (Date.parse(a.CheckedAt) || 0));
    value = records.find(record => record.URL)?.URL || value;
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) throw fault('生成引擎地址必须是本机 HTTP 地址。');
    return url.origin;
  }
  async function upstream(path, options = {}) {
    let response;
    try { response = await fetch(engineUrl() + path, { ...options, signal: AbortSignal.timeout(20000) }); }
    catch { throw fault('暂时无法连接 ComfyUI，请先打开原启动入口，再点击重新连接。', 503); }
    if (!response.ok) {
      const message = await response.text();
      let detail;
      try { detail = JSON.parse(message); } catch { detail = { message }; }
      const errors = Object.values(detail.node_errors ?? {}).flatMap(node => node.errors ?? []).map(error => error.message + (error.details ? `：${error.details}` : ''));
      throw Object.assign(fault(errors.join('\n') || detail.error?.message || detail.message || '生成引擎拒绝了请求。', response.status), { nodeErrors: detail.node_errors });
    }
    return response;
  }
  async function json(path, options) { return (await upstream(path, options)).json(); }
  async function post(path, value) {
    const response = await upstream(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }
  async function nodeInfo() {
    const url = engineUrl();
    if (!infoCache || infoUrl !== url || Date.now()-infoLoadedAt>30000) { infoCache = await json('/object_info'); infoUrl = url; infoLoadedAt=Date.now(); }
    return infoCache;
  }
  function publicJob(job) {
    const primary = primaryOutput(job);
    return { ...job, outputs: (job.outputs ?? []).map(file => ({ ...file, url: `/api/media/${job.id}/${file.index}` })).sort((a, b) => Number(b.index === primary?.index) - Number(a.index === primary?.index)) };
  }
  function workflowSnapshot(prompt,source='submission') { return {version:'0.7.0',source,capturedAt:new Date().toISOString(),sha256:createHash('sha256').update(JSON.stringify(prompt)).digest('hex'),models:Object.values(prompt).flatMap(n=>['unet_name','clip_name','vae_name','lora_name',...(n.class_type==='ModelPatchLoader'?['name']:[])].filter(k=>n.inputs[k]).map(k=>n.inputs[k])),graph:structuredClone(prompt)}; }
  function mediaOutputs(history) {
    const files = [];
    for (const [nodeId,output] of Object.entries(history.outputs ?? {})) {
      if(history.prompt?.[2]?.[nodeId]?.class_type==='LoadVideo')continue;
      for (const kind of ['images', 'gifs', 'videos', 'audio']) {
        for (const file of output[kind] ?? []) {
          if (!file.filename || files.some(item => item.filename === file.filename && item.subfolder === file.subfolder)) continue;
          files.push({ index: files.length, filename: file.filename, subfolder: file.subfolder ?? '', type: file.type ?? 'output', metadata: file.metadata, kind: /\.(mp4|webm|mkv)$/i.test(file.filename) ? 'video' : /\.(wav|mp3|flac)$/i.test(file.filename) ? 'audio' : 'image' });
        }
      }
    }
    return files;
  }
  async function refresh() {
    if (updating || closed) return;
    const jobs = state.jobs.filter(job => activeStates.has(job.status)&&job.template!=='video-upscale');
    if (!jobs.length) return;
    updating = true;
    try {
      const queue = await json('/queue');
      const running = new Set(queue.queue_running.map(item => item[1]));
      const pending = new Set(queue.queue_pending.map(item => item[1]));
      for (const job of jobs) {
        const history = (await json(`/history/${job.id}`))[job.id];
        if (history) {
          const status = history.status;
          if (status?.completed && status.status_str === 'success') {
            job.outputs = mediaOutputs(history);
            job.status = job.outputs.length ? 'success' : 'failed';
            job.error = job.outputs.length ? null : '任务结束，但没有找到保存的成品。';
          } else if (status?.status_str === 'error') {
            const event = status.messages?.findLast(item => ['execution_error', 'execution_interrupted'].includes(item[0]));
            job.status = event?.[0] === 'execution_interrupted' ? 'cancelled' : 'failed';
            job.error = event?.[1]?.exception_message || (job.status === 'cancelled' ? '任务已停止。' : '生成失败，请查看 ComfyUI 日志。');
          } else continue;
          job.finishedAt = new Date().toISOString();
          if (job.status === 'success') job.progress = null;
        } else if (running.has(job.id)) { job.status = 'running'; job.error = null; job.missingSince = null; }
        else if (pending.has(job.id)) { job.status = 'queued'; job.error = null; job.missingSince = null; }
        else if (job.status !== 'submitting') {
          job.missingSince ??= Date.now();
          job.status = Date.now() - job.missingSince > 30000 ? 'failed' : 'recovering';
          job.error = job.status === 'failed' ? '引擎中已找不到此任务。请检查 ComfyUI 是否重启，确认后重新提交。' : '正在核对引擎任务记录…';
          if (job.status === 'failed') job.finishedAt = new Date().toISOString();
        }
      }
      save();
    } catch (error) {
      for (const job of jobs) { job.status = 'recovering'; job.error = error.message; }
      save();
    } finally { updating = false; }
  }
  function connectEvents() {
    if (!websocket || closed) return;
    let url;
    try { url = engineUrl(); } catch { return; }
    if (ws && wsUrl === url && [WebSocket.OPEN, WebSocket.CONNECTING].includes(ws.readyState)) return;
    ws?.close();
    wsUrl = url;
    ws = new WebSocket(url.replace('http:', 'ws:') + '/ws?clientId=' + clientId);
    ws.addEventListener('error', () => {});
    ws.addEventListener('message', event => {
      if (typeof event.data !== 'string') return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      const data = message.data;
      const job = state.jobs.find(item => item.id === data?.prompt_id);
      if (!job) return;
      if (message.type === 'execution_start') { job.status = 'running'; job.error = null; }
      if (message.type === 'executing' && data.node) { job.node = data.node; job.progress = null; }
      if (message.type === 'progress') job.progress = { value: data.value, max: data.max };
      if (['execution_success', 'execution_error', 'execution_interrupted'].includes(message.type) || (message.type === 'executing' && data.node === null)) void refresh();
      save();
    });
  }

  async function prepareJob(body, context = {}) {
    let input;
    try { input = parseRequest(body); } catch (error) { throw fault(error.message); }
    if(input.template==='h3-reference'&&!config.enableRef2VA)throw fault('Ref2VA 尚未通过本机验证，暂不能生成。');
    const images = input.images.map(id => { if (!state.uploads[id]) throw fault('请重新上传所需图片。'); return storage.imageName(context.projectId,id); });
    const id = body.requestId ?? randomUUID();
    if (!/^[a-f0-9-]{36}$/.test(id)) throw fault('任务编号无效。');
    const graph = await loadGraph(appRoot, input.template);
    const driver=input.template==='h3-depth'?drivers.clip(input.driverClipId,context.projectId):undefined;
    const prompt = compileGraph(graph, { ...input, images, driver, storagePrefix: storage.prefix(context,id,templates.find(t=>t.id===input.template).section) }, id);
    const issues = checkGraph(prompt, await nodeInfo());
    if (issues.length) throw fault(issues.join('\n'));
    return { input, id, prompt };
  }
  async function submitJob(body, context = {}) {
    const existing = state.jobs.find(job => job.id === body.requestId);
    if (existing) return existing;
    if (submitting || projects.isExporting() || upscale.busy()) throw fault('正在提交任务、高清精修或拼接成片，请稍候。', 409);
    submitting = true;
    try {
      const { input, id, prompt } = await prepareJob(body, context);
      await refresh();
      if (state.jobs.some(job => activeStates.has(job.status))) throw fault('已有任务正在处理，请等待完成。', 409);
      const queue = await json('/queue');
      if (queue.queue_running.length || queue.queue_pending.length) throw fault('ComfyUI 正在处理其他任务，请稍后再试。', 409);
      const template = templates.find(item => item.id === input.template);
      await assistant.release();
      const job = { id, ...input, ...context, workflowSnapshot:workflowSnapshot(prompt), title: template.name, section: template.section, status: 'submitting', createdAt: new Date().toISOString(), outputs: [] };
      state.jobs.unshift(job); save(); connectEvents();
      try {
        const result = await post('/prompt', { prompt, prompt_id: id, client_id: clientId });
        if (result.prompt_id !== id) throw fault('引擎返回了不匹配的任务编号。', 502);
        job.status = 'queued';
      } catch (error) { job.status = error.status === 503 ? 'recovering' : 'failed'; job.error = error.message; }
      save(); return job;
    } finally { submitting = false; }
  }
  const drivers=createDrivers({state,save,config,appRoot,storage,send,readBody});
  const projects = createProjects({ state, save, submitJob, refresh, json, upstream, publicJob, config, appRoot, dataRoot, send, readBody, isEnhancing:()=>upscale.busy()||drivers.busy(), finalizeVideos:()=>upscale.tick(),resolveDriver:(id,pid)=>drivers.clip(id,pid),removeProject:id=>lifecycle.removeProject(id) });
  const prompts = createPromptLibrary({ state, save, appRoot, dataRoot, config, send, readBody });
  const projectFiles = createProjectFiles({state,save,config,appRoot,dataRoot,send,readBody});
  const assistant = createAssistant({config,state,save,dataRoot,json,send,readBody,isGenerating:()=>submitting||projects.isExporting()||upscale.busy()||state.jobs.some(j=>activeStates.has(j.status))});
  const upscale=createUpscaler({state,save,config,appRoot,send,readBody,json,post,publicJob,isBusy:()=>submitting||projects.isExporting()||state.jobs.some(j=>activeStates.has(j.status))||state.batchQueue.some(q=>['waiting','dispatched'].includes(q.status)),release:()=>assistant.release()});
  const timer = setInterval(() => { connectEvents(); if(!submitting&&!upscale.busy()&&!drivers.busy()&&!projects.isExporting()&&!state.jobs.some(j=>activeStates.has(j.status))&&!state.batchQueue.some(q=>['waiting','dispatched'].includes(q.status))){try{if(lifecycle.reconcile())save();}catch(error){console.error('媒体同步暂未完成：',error.message);}} void projects.tick(); }, 3000);
  timer.unref();
  for (const job of state.jobs) if (activeStates.has(job.status)) job.status = 'recovering';

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://' + req.headers.host);
      if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw fault('仅支持本机访问。', 403);
      if (!['GET', 'HEAD'].includes(req.method)) {
        if (req.headers.origin && req.headers.origin !== url.origin) throw fault('请求来源不匹配。', 403);
        if (!url.pathname.startsWith('/api/uploads') && url.pathname!=='/api/audio' && url.pathname!=='/api/projects/import' && !/^\/api\/projects\/[a-f0-9-]+\/drivers$/.test(url.pathname) && req.headers['content-type']?.split(';')[0] !== 'application/json') throw fault('请求必须使用 JSON。', 415);
      }
      if (await storage.handle(req,res,url,send)) return;
      if (await upscale.handle(req,res,url)) return;
      if (await drivers.handle(req,res,url)) return;
      if (await assistant.handle(req,res,url)) return;
      if (await projectFiles.handle(req,res,url)) return;
      if (await projects.handle(req, res, url)) return;
      if (await prompts.handle(req, res, url)) return;
      if (req.method === 'GET' && url.pathname === '/api/status') {
        let system;
        let error;
        try { system = await json('/system_stats'); connectEvents(); } catch (err) { error = err.message; }
        return send(res, 200, { name: config.name, connected: !!system, engineUrl: engineUrl(), system, error });
      }
      if (req.method === 'GET' && url.pathname === '/api/templates') {
        let info;
        try { info = await nodeInfo(); } catch { /* Templates remain readable while the engine is stopped. */ }
        const result = [];
        for (const template of templates.filter(item => !item.internal)) {
          const graph = await loadGraph(appRoot, template.id);
          const sample = { template: template.id, prompt: template.defaultPrompt, seed: 42, size: '512x512', images: Array(template.images).fill('example.png') };
          const issues = info ? checkGraph(compileGraph(graph, sample, 'check'), info) : ['生成引擎未连接'];
          if(template.experimental&&!config.enableRef2VA)issues.push('实验路径尚未启用本机验收。');
          result.push({ ...template, available: !issues.length, issues });
        }
        return send(res, 200, result);
      }
      if (req.method === 'GET' && url.pathname === '/api/jobs') {
        await refresh();
        return send(res, 200, state.jobs.filter(job => !job.deletedAt).map(publicJob));
      }
      if (req.method === 'POST' && url.pathname === '/api/jobs/delete') {
        const jobIds = JSON.parse((await readBody(req)).toString('utf8'))?.jobIds;
        if (!Array.isArray(jobIds) || !jobIds.length || jobIds.some(id => typeof id !== 'string') || new Set(jobIds).size !== jobIds.length) throw fault('请选择要删除的作品，编号不能重复。');
        const targets = jobIds.map(id => state.jobs.find(job => job.id === id));
        if (targets.some(job => !job)) throw fault('所选作品中有不存在的记录，本次未删除任何作品。', 404);
        if (targets.some(job => activeStates.has(job.status))) throw fault('所选内容中有正在生成的任务，请等待结束后再删除。本次未删除任何作品。', 409);
        if(submitting||upscale.busy()||drivers.busy()||projects.isExporting()||state.jobs.some(j=>activeStates.has(j.status))||state.batchQueue.some(q=>['waiting','dispatched'].includes(q.status)))throw fault('请先完成或取消生成队列，再彻底删除媒体。',409);
        const pending = targets;
        if (pending.length) {
          lifecycle.removeJobs(pending.map(j=>j.id));
          save();
        }
        return send(res, 200, { deletedIds: jobIds, filesPreserved: false });
      }
      if (req.method === 'POST' && url.pathname === '/api/uploads') {
        const type = req.headers['content-type']?.split(';')[0];
        if (!imageTypes.has(type)) throw fault('请上传 PNG、JPG 或 WebP 图片。', 415);
        const data = await readBody(req, 20 * 1024 * 1024);
        const valid = type === 'image/png' ? data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : type === 'image/jpeg' ? data[0] === 255 && data[1] === 216 && data[2] === 255 : data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP';
        if (!valid) throw fault('图片内容与文件格式不符。');
        const id = randomUUID();
        const name = id + (type === 'image/png' ? '.png' : type === 'image/jpeg' ? '.jpg' : '.webp');
        const form = new FormData();
        form.set('image', new Blob([data], { type }), name);
        form.set('subfolder', 'aigc-studio');
        form.set('type', 'input');
        const uploaded = await json('/upload/image', { method: 'POST', body: form });
        const engineName = [uploaded.subfolder, uploaded.name].filter(Boolean).join('/');
        state.uploads[id] = { name: engineName, type };
        save();
        return send(res, 201, { id, url: '/api/uploads/' + id });
      }
      const uploadMatch = url.pathname.match(/^\/api\/uploads\/([a-f0-9-]+)$/);
      if (req.method === 'GET' && uploadMatch) {
        const upload = state.uploads[uploadMatch[1]];
        if (!upload) throw fault('图片不存在。', 404);
        const file=uploadFile(upload);
        return await streamMedia(`/view?${new URLSearchParams({ filename:file.filename,subfolder:file.subfolder,type:file.type })}`, req, res);
      }
      if (req.method === 'POST' && ['/api/jobs', '/api/compile'].includes(url.pathname)) {
        const body = JSON.parse((await readBody(req)).toString('utf8'));
        if (url.pathname === '/api/compile') return send(res, 200, { prompt: (await prepareJob(body)).prompt, valid: true });
        const existing = state.jobs.some(job => job.id === body.requestId);
        return send(res, existing ? 200 : 201, publicJob(await submitJob(body)));
      }
      const deleteWork = url.pathname.match(/^\/api\/jobs\/([a-f0-9-]+)$/);
      if (req.method === 'DELETE' && deleteWork) {
        const job = state.jobs.find(item => item.id === deleteWork[1]);
        if (!job) throw fault('作品或任务不存在。', 404);
        if (activeStates.has(job.status)) throw fault('此任务仍在运行，请先停止任务并等待结束后再删除。', 409);
        if(submitting||upscale.busy()||drivers.busy()||projects.isExporting()||state.jobs.some(j=>activeStates.has(j.status))||state.batchQueue.some(q=>['waiting','dispatched'].includes(q.status)))throw fault('请先完成或取消生成队列，再彻底删除媒体。',409);
        lifecycle.removeJobs([job.id]);save();
        return send(res, 200, { deleted: true, id: job.id, filesPreserved: false });
      }
      const auditMatch=url.pathname.match(/^\/api\/jobs\/([a-f0-9-]+)\/audit$/);
      if(req.method==='POST'&&auditMatch){const job=state.jobs.find(j=>j.id===auditMatch[1]);if(!job)throw fault('任务不存在。',404);if(!job.workflowSnapshot){const history=(await json('/history/'+job.id))[job.id];const prompt=history?.prompt?.[2];if(!prompt)throw fault('引擎历史已不存在；保留原参数，不补造执行图。');job.workflowSnapshot=workflowSnapshot(prompt,'engine-history');save();}return send(res,200,job.workflowSnapshot);}
      const cancelMatch = url.pathname.match(/^\/api\/jobs\/([a-f0-9-]+)\/cancel$/);
      if (req.method === 'POST' && cancelMatch) {
        const job = state.jobs.find(item => item.id === cancelMatch[1]);
        if (!job || !activeStates.has(job.status)) throw fault('此任务已结束或不存在。');
        const queue = await json('/queue');
        if (queue.queue_running.some(item => item[1] === job.id)) {
          // Always scope interruption to this job, including if the queue advances during this request.
          await post('/interrupt', { prompt_id: job.id });
          job.error = '已请求停止，正在等待引擎确认…';
        } else if (queue.queue_pending.some(item => item[1] === job.id)) {
          await post('/queue', { delete: [job.id] });
          job.status = 'cancelled'; job.finishedAt = new Date().toISOString();
        } else { await refresh(); }
        save();
        return send(res, 200, publicJob(job));
      }
      const mediaMatch = url.pathname.match(/^\/api\/media\/([a-f0-9-]+)\/(\d+)$/);
      if (req.method === 'GET' && mediaMatch) {
        const job = state.jobs.find(item => item.id === mediaMatch[1]);
        let file = job?.outputs?.[Number(mediaMatch[2])];
        if (file?.type === 'temp' && !existsSync(localMedia(config, file) || '')) file = primaryOutput(job);
        if (!file) throw fault('作品不存在。', 404);
        const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type });
        return await streamMedia('/view?' + query, req, res, url.searchParams.has('download') ? file.filename : null);
      }
      if (req.method === 'GET' && url.pathname === '/api/roadmap') {
        return send(res, 200, { content: await readFile(resolve(appRoot, '制作路线.md'), 'utf8') });
      }
      const pages = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/icon.svg': 'icon.svg', '/favicon.ico': 'icon.svg', '/projects.js': 'projects.js', '/projects.css': 'projects.css', '/prompts.js': 'prompts.js', '/prompts.css': 'prompts.css', '/video-options.js': 'video-options.js', '/director-options.js':'director-options.js', '/upscale.js':'upscale.js', '/drivers.js':'drivers.js', '/drivers.css':'drivers.css', '/production-ui.js':'production-ui.js', '/production.css':'production.css' };
      if (req.method === 'GET' && pages[url.pathname]) {
        const file = pages[url.pathname];
        res.writeHead(200, { 'Content-Type': mime[extname(file)], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
        return res.end(await readFile(resolve(appRoot, 'public', file)));
      }
      throw fault('页面不存在。', 404);
    } catch (error) {
      if (res.headersSent) return res.destroy();
      send(res, error instanceof SyntaxError ? 400 : error.status ?? 500, { error: error.status || error instanceof SyntaxError ? error.message : '处理请求时发生错误，请查看控制台。' });
      if (!error.status && !(error instanceof SyntaxError)) console.error(error);
    }
  });
  async function streamMedia(path, req, res, downloadName) {
    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;
    const response = await upstream(path, { headers });
    const outgoing = { 'Content-Type': response.headers.get('content-type') ?? 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    for (const name of ['content-length', 'content-range', 'accept-ranges']) if (response.headers.has(name)) outgoing[name] = response.headers.get(name);
    if (downloadName) outgoing['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
    res.writeHead(response.status, outgoing);
    const stream = Readable.fromWeb(response.body);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }
  server.on('close', () => { closed = true; clearInterval(timer); ws?.close(); assistant.close(); upscale.close(); });
  return { server, state, refresh, tick: projects.tick };
}

async function main() {
  const config = JSON.parse(await readFile(resolve(root, 'config.json'), 'utf8'));
  const { server } = createStudio(config);
  let port = Number(process.env.STUDIO_PORT ?? config.port);
  for (let attempt = 0; attempt < 30; attempt++, port++) {
    try {
      await new Promise((ok, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); ok(); }); });
      const url = `http://127.0.0.1:${port}`;
      writeFileSync(resolve(root, 'data', 'server.json'), JSON.stringify({ url, pid: process.pid }));
      console.log(`\n${config.name} 已启动：${url}\n关闭此窗口可停止创作台。ComfyUI 由原入口管理。`);
      return;
    } catch (error) { if (!['EADDRINUSE', 'EACCES'].includes(error.code)) throw error; }
  }
  throw new Error('没有找到可用端口，请修改 config.json 中的 port。');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error); process.exitCode = 1; });
