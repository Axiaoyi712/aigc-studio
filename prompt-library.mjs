import { readFileSync, existsSync, createReadStream, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export function createPromptLibrary({ state, save, appRoot, dataRoot, config, send, readBody }) {
  state.promptFavorites ??= [];
  state.userPrompts ??= [];
  let catalog;
  let refresh = { status: 'idle' };
  const sourceRoot = resolve(config.promptLibraryRoot || resolve(config.comfyRoot, '../../..', '提示词合集'));
  const updated = resolve(dataRoot, 'prompt-catalog.json');
  function load() {
    if (!catalog) catalog = JSON.parse(readFileSync(existsSync(updated) ? updated : resolve(appRoot, 'library/catalog.json'), 'utf8'));
    return catalog;
  }
  function find(id) { return [...state.userPrompts, ...load().entries].find(item => item.id === id); }
  function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
  async function handle(req, res, url) {
    if (!/^\/api\/prompts(?:\/|$)/.test(url.pathname)) return false;
    const parts = url.pathname.split('/').filter(Boolean);
    const body = req.method === 'POST' ? JSON.parse((await readBody(req)).toString('utf8')) : null;
    if (req.method === 'GET' && parts.length === 2) {
      const data = load();
      const tokens = (url.searchParams.get('search') || '').toLowerCase().split(/\s+/).filter(Boolean);
      const kind = url.searchParams.get('kind'); const group = url.searchParams.get('group');
      const items = [...state.userPrompts, ...data.entries].filter(item => (!kind || item.kind === kind) && (!group || item.group === group) && (url.searchParams.get('favorites') !== '1' || state.promptFavorites.includes(item.id)) && tokens.every(token => `${item.title}\n${item.source}\n${item.body}`.toLowerCase().includes(token)));
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      send(res, 200, { total: items.length, allCount: data.entries.length + state.userPrompts.length, sourceCount: data.sources.length, builtAt: data.builtAt, issues: data.issues, refresh, items: items.slice(offset, offset + 40).map(({ body, ...item }) => ({ ...item, preview: body.slice(0, 120), favorite: state.promptFavorites.includes(item.id) })) });
    } else if (req.method === 'POST' && parts[2] === 'favorite') {
      if (!find(body.id)) fail('提示词不存在。', 404);
      state.promptFavorites = state.promptFavorites.filter(id => id !== body.id);
      if (body.favorite) state.promptFavorites.push(body.id);
      save(); send(res, 200, { favorite: !!body.favorite });
    } else if (req.method === 'POST' && parts[2] === 'custom') {
      if (!['video', 'image', 'instruction'].includes(body.kind) || !String(body.title || '').trim() || !String(body.body || '').trim() || String(body.body).length > 30000) fail('请填写标题、类别与正文，正文不超过 30000 字。');
      const item = { id: 'my-' + randomUUID(), title: String(body.title).trim().slice(0, 180), body: String(body.body).trim(), kind: body.kind, group: '我的提示词', source: '我的提示词', location: '自定义', sourceModel: '自定义' };
      state.userPrompts.unshift(item); save(); send(res, 201, item);
    } else if (req.method === 'POST' && parts[2] === 'refresh') {
      if (refresh.status === 'running') { send(res, 200, refresh); return true; }
      const python = resolve(process.env.LOCALAPPDATA || '', 'Programs/Python/Python39/python.exe');
      if (!existsSync(python)) fail('未找到本机原有的文档读取 Python 环境；现有目录仍可使用。');
      refresh = { status: 'running' };
      const child = spawn(python, [resolve(appRoot, 'scripts/import-prompt-library.py'), sourceRoot, updated], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      let output = ''; let error = '';
      child.stdout.on('data', bytes => { output += bytes.toString(); }); child.stderr.on('data', bytes => { error = (error + bytes.toString()).slice(-3000); });
      child.on('error', err => { refresh = { status: 'failed', error: err.message }; });
      child.on('close', code => { if (code === 0) { catalog = null; refresh = { status: 'success', summary: output.trim() }; } else refresh = { status: 'failed', error }; });
      send(res, 202, refresh);
    } else if (req.method === 'GET' && parts.length >= 3) {
      const item = find(parts[2]); if (!item) fail('提示词不存在。', 404);
      if (parts[3] === 'source') {
        if (item.source === '我的提示词') fail('自定义提示词没有原始文档。');
        const file = realpathSync(resolve(sourceRoot, item.source));
        if (!file.startsWith(realpathSync(sourceRoot) + sep)) fail('原文件路径不在提示词库内。', 403);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(item.source.split('/').at(-1))}` });
        const stream = createReadStream(file); stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
      } else send(res, 200, { ...item, favorite: state.promptFavorites.includes(item.id) });
    } else fail('接口不存在。', 404);
    return true;
  }
  return { handle };
}
