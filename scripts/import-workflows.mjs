import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { templates } from '../workflows.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(resolve(root, 'config.json'), 'utf8'));
await mkdir(resolve(root, 'workflows'), { recursive: true });
for (const template of templates) {
  if (!template.source) continue;
  const graph = JSON.parse(await readFile(resolve(config.comfyRoot, 'user/default/workflows', template.source), 'utf8'));
  for (const node of graph.nodes) {
    if (node.type === 'Note') node.widgets_values = ['此副本用于我的 AIGC。原始工作流保留在 ComfyUI 中。'];
    if (node.type === 'CLIPTextEncode' && node.widgets_values?.[0]) node.widgets_values[0] = template.defaultPrompt;
    if (node.type === 'MiniMaxH3ImageToVideo') node.widgets_values[0] = template.defaultPrompt;
    if (node.type === 'LoadImage') node.widgets_values[0] = 'example.png';
  }
  await writeFile(resolve(root, 'workflows', template.file), JSON.stringify(graph, null, 2) + '\n');
  console.log(`已创建独立副本：${template.name}`);
}
