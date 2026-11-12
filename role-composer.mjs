import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeComposition, composeReferencePrompt } from './public/composition.js';
import { projectAssets } from './asset-catalog.mjs';
import { uploadPath } from './uploads.mjs';

const fault = (message, status = 400) => Object.assign(Error(message), { status });
const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
export function createRoleComposer({ state, config, dataRoot, save, send, readBody, submitJob, publicJob, lifecycle, isBusy, storage }) {
  state.compositionRecipes ??= [];
  state.compositionReferences ??= [];
  const output = resolve(config.comfyRoot, 'output');
  const libraryRoot = resolve(output, 'AIGC项目', '公共素材库', '参考图库');
  function records() {
    const path = resolve(dataRoot, 'reference-library.json');
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).records || [] : [];
  }
  function libraryPath(record) {
    const path = resolve(output, record.file || '');
    if (!mime[extname(path).toLowerCase()] || !path.startsWith(libraryRoot + sep) || !existsSync(path) || !realpathSync(path).startsWith(realpathSync(libraryRoot) + sep)) throw fault('参考图已删除或移动，请重新导入。', 404);
    const stat = statSync(path);
    if (!stat.isFile() || stat.size === 0 || stat.size > 20 * 1024 * 1024) throw fault('参考图片无效。');
    return path;
  }
  function library() {
    return records().flatMap(record => {
      try { libraryPath(record); } catch { return []; }
      const { file, ...item } = record;
      return [{ ...item, url: '/api/composer/library/' + encodeURIComponent(record.id) + '/image' }];
    });
  }
  function ensureReferences(composition) {
    const paths = new Set();
    for (const ref of composition.references) {
      const path = uploadPath(config, state.uploads[ref.uploadId]);
      if (!path || !existsSync(path)) throw fault(`${ref.name}的原图已删除或移动，请重新选择。`, 409);
      const key = realpathSync(path).toLowerCase();
      if (paths.has(key)) throw fault('同一张原图请只放在一个参考槽，避免用途冲突。');
      paths.add(key);
    }
  }
  function normalized(value) {
    let result;
    try { result = normalizeComposition(value); } catch (error) { throw fault(error.message); }
    ensureReferences(result);
    return result;
  }
  function project(id) {
    return state.projects.find(p => p.id === id) || (() => { throw fault('项目不存在。', 404); })();
  }
  async function handle(req, res, url) {
    if (!url.pathname.startsWith('/api/composer')) return false;
    if (req.method === 'GET' && url.pathname === '/api/composer') {
      const recipes = state.compositionRecipes.map(recipe => ({ ...recipe, missing: [...(recipe.missingReferences || []), ...recipe.composition.references.filter(ref => !existsSync(uploadPath(config, state.uploads[ref.uploadId]) || '')).map(ref => ref.name)] }));
      send(res, 200, { library: library(), recipes, projects: state.projects.map(p => ({ id: p.id, name: p.name, shots: p.shots.map(s => ({ id: s.id, title: s.title })) })) });
      return true;
    }
    const image = url.pathname.match(/^\/api\/composer\/library\/([^/]+)\/image$/);
    if (image && req.method === 'GET') {
      const record = records().find(r => r.id === decodeURIComponent(image[1]));
      if (!record) throw fault('参考图不存在。', 404);
      const path = libraryPath(record);
      res.writeHead(200, { 'Content-Type': mime[extname(path).toLowerCase()], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      res.end(readFileSync(path));
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/composer/sources') {
      const pid = url.searchParams.get('projectId');
      const assets = pid ? projectAssets(state, project(pid)) : state.assets.filter(a => a.scope === 'shared');
      const custom = state.compositionReferences.filter(r => (r.projectId || null) === (pid || null)).map(r => ({ ...r, custom: true }));
      const unique = [...new Map([...assets, ...custom].map(a => [a.uploadId, a])).values()];
      const categories = { character: '角色', scene: '场景', prop: '道具', style: '风格', person: '角色', outfit: '服装', pose: '姿势' };
      send(res, 200, unique.filter(a => existsSync(uploadPath(config, state.uploads[a.uploadId]) || '')).map(a => ({ id: a.id, name: a.name, category: categories[a.category || a.role] || a.category, role: a.role, custom: a.custom, groupId: a.groupId || a.id, groupName: a.groupName, view: a.view, uploadId: a.uploadId, url: '/api/uploads/' + a.uploadId })));
      return true;
    }
    const reference = url.pathname.match(/^\/api\/composer\/references\/([a-f0-9-]{36})$/);
    if (reference && req.method === 'DELETE') {
      if (isBusy()) throw fault('请等待生成或导出完成，再删除参考图片。', 409);
      const item = state.compositionReferences.find(r => r.id === reference[1]);
      if (!item) throw fault('自定义参考不存在。', 404);
      const result = lifecycle.detach([uploadPath(config, state.uploads[item.uploadId])]);
      save(); send(res, 200, result); return true;
    }
    const recipe = url.pathname.match(/^\/api\/composer\/recipes\/([a-f0-9-]{36})$/);
    if (recipe && req.method === 'DELETE') {
      if (!state.compositionRecipes.some(r => r.id === recipe[1])) throw fault('配方不存在。', 404);
      state.compositionRecipes = state.compositionRecipes.filter(r => r.id !== recipe[1]);
      save(); send(res, 200, { deleted: true }); return true;
    }
    if (req.method !== 'POST') throw fault('接口不存在。', 404);
    const body = JSON.parse((await readBody(req)).toString('utf8'));
    if (url.pathname === '/api/composer/references') {
      if (!['person', 'personB', 'outfit', 'pose', 'scene'].includes(body.role)) throw fault('请选择参考用途。');
      if (!existsSync(uploadPath(config, state.uploads[body.uploadId]) || '')) throw fault('图片不存在，请重新上传。');
      const p = body.projectId ? project(body.projectId) : null;
      const name = String(body.name || '').trim();
      if (!name || name.length > 80) throw fault('参考名称为 1～80 字。');
      const item = { id: randomUUID(), role: body.role === 'personB' ? 'person' : body.role, uploadId: body.uploadId, name, projectId: body.projectId || null };
      const source = uploadPath(config, state.uploads[body.uploadId]);
      const alreadyUsed = [...state.assets, ...state.compositionReferences].some(r => uploadPath(config, state.uploads[r.uploadId]) === source);
      if (p && !alreadyUsed && source.startsWith(resolve(output, 'AIGC项目', '公共素材库', '上传') + sep)) {
        const folder = { person: '角色', personB: '角色', outfit: '道具', pose: '姿势参考', scene: '场景' }[body.role];
        storage.relocate(source, resolve(storage.projectFolder(p), folder, '合成参考', body.uploadId + extname(source)));
      }
      state.compositionReferences.push(item); save(); send(res, 201, item); return true;
    }
    if (url.pathname === '/api/composer/library/use') {
      const record = records().find(r => r.id === body.id);
      if (!record) throw fault('参考图不存在。', 404);
      libraryPath(record);
      const file = { type: 'output', subfolder: record.file.split('/').slice(0, -1).join('/'), filename: record.file.split('/').at(-1) };
      let pair = Object.entries(state.uploads).find(([, u]) => u.file?.type === file.type && u.file?.subfolder === file.subfolder && u.file?.filename === file.filename);
      if (!pair) { pair = [randomUUID(), { file, type: mime[extname(file.filename).toLowerCase()], libraryId: record.id }]; state.uploads[pair[0]] = pair[1]; save(); }
      send(res, 200, { uploadId: pair[0], name: record.name, url: '/api/composer/library/' + encodeURIComponent(record.id) + '/image' }); return true;
    }
    if (url.pathname === '/api/composer/recipes') {
      const name = String(body.name || '').trim();
      if (!name || name.length > 80) throw fault('请填写 1～80 字的配方名称。');
      const composition = normalized(body.composition);
      const item = { id: randomUUID(), name, composition, createdAt: new Date().toISOString() };
      state.compositionRecipes.unshift(item); save(); send(res, 201, item); return true;
    }
    if (url.pathname === '/api/composer/preview') {
      const composition = normalized(body.composition);
      send(res, 200, { composition, prompt: composeReferencePrompt(composition) }); return true;
    }
    if (url.pathname === '/api/composer/generate') {
      const composition = normalized(body.composition), context = {};
      if (body.projectId) {
        const p = project(body.projectId);
        if (!body.shotId || !p.shots.some(s => s.id === body.shotId)) throw fault('请选择该项目中的目标镜头。');
        context.projectId = p.id; context.shotId = body.shotId;
      } else if (body.shotId) throw fault('请先选择项目。');
      const job = await submitJob({ requestId: body.requestId, template: 'flux-compose', composition }, context);
      send(res, 201, publicJob(job)); return true;
    }
    throw fault('接口不存在。', 404);
  }
  return { handle };
}
