import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';

export function primaryOutput(job) {
  return job?.outputs?.find(file => file.type === 'output' && ['image', 'video'].includes(file.kind)) ?? job?.outputs?.[0];
}
export function localMedia(config, file) {
  if (!file || !['input', 'output', 'temp'].includes(file.type)) return null;
  const base = resolve(config.comfyRoot, file.type);
  const path = resolve(base, file.subfolder || '', file.filename);
  return path.startsWith(base + sep) ? path : null;
}
export function requireMedia(config, file) {
  const path = localMedia(config, file);
  if (!path || (existsSync(config.comfyRoot) && !existsSync(path))) throw Object.assign(Error('素材文件缺失，请检查项目引用；已有正式图片时无需重画。'), { status: 400 });
  return path;
}
