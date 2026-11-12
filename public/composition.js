export const referenceRoles = [
  { id: 'person', name: '人物 A', hint: '五官、发型与身份；未指定服装时沿用本图服装' },
  { id: 'personB', name: '人物 B', hint: '第二位人物，保留其身份与服装' },
  { id: 'outfit', name: '人物 A 的服装', hint: '只参考服装，不继承模特的脸和体型' },
  { id: 'pose', name: '姿势／构图', hint: '动作、机位、人物占比与遮挡；不继承其人物外观' },
  { id: 'scene', name: '场景', hint: '环境、材质、光照；按当前景别呈现局部' }
];
export const compositionStyles = {
  reference: '跟随参考图',
  realistic: '自然写实',
  film: '电影胶片',
  studio: '摄影棚角色定稿',
  illustration: '插画',
  render: '3D 角色'
};
export const compositionSizes = ['768x1024', '1024x768', '1024x1024', '720x1280', '1280x720', '1536x2048', '2048x1536', '2048x2048'];
const styleText = {
  reference: '统一参考图的画风、材质和光照，保持完整连贯的单幅画面。',
  realistic: '自然写实摄影，真实皮肤与布料质感，合理人体比例，自然光影，克制的表情，不使用过度磨皮。',
  film: '写实电影镜头，自然肤色，柔和光影层次，轻微胶片颗粒，统一色温，避免过度锐化。',
  studio: '一位人物的摄影棚角色定稿照，简洁背景，均匀柔光，脸部清晰；除非明确要求，不制作多视图排版。',
  illustration: '统一的精细插画风格，清晰的轮廓和色彩层次，人物与环境画风协调。',
  render: '统一的 3D 角色渲染风格，连贯的材质、体积与光影，合理身体比例。'
};
export function normalizeComposition(value = {}) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.references)) throw Error('请选择人物和参考图片。');
  const seen = new Set();
  const references = value.references.map(ref => {
    if (!ref || !referenceRoles.some(role => role.id === ref.role) || seen.has(ref.role)) throw Error('参考用途无效或重复，请重新选择。');
    seen.add(ref.role);
    if (typeof ref.uploadId !== 'string' || !/^[a-f0-9-]{36}$/.test(ref.uploadId)) throw Error('参考图片编号无效，请重新选择。');
    return { role: ref.role, uploadId: ref.uploadId, name: String(ref.name || referenceRoles.find(r => r.id === ref.role).name).slice(0, 80) };
  }).sort((a, b) => referenceRoles.findIndex(r => r.id === a.role) - referenceRoles.findIndex(r => r.id === b.role));
  if (!references.some(ref => ref.role === 'person')) throw Error('请先选择人物 A。');
  if (references.length < 2 || references.length > 5) throw Error('请选择人物，并至少添加一张姿势、服装、场景或人物 B 参考。');
  if (new Set(references.map(ref => ref.uploadId)).size !== references.length) throw Error('同一张图请只放在一个参考槽，避免用途冲突。');
  const description = String(value.description || '').trim();
  if (description.length > 2000) throw Error('补充描述最多 2000 字。');
  const mapping = String(value.mapping || '').trim();
  if (mapping.length > 300) throw Error('人物对应说明最多 300 字。');
  if (seen.has('personB') && !mapping) throw Error('双人合成请填写人物 A、B 的站位或对应关系。');
  const style = value.style || 'realistic', size = value.size || '768x1024';
  if (!Object.hasOwn(compositionStyles, style)) throw Error('请选择提供的画风。');
  if (!compositionSizes.includes(size)) throw Error('请选择提供的合成尺寸。');
  const seed = value.seed === '' || value.seed == null ? '' : Number(value.seed);
  if (seed !== '' && (!Number.isSafeInteger(seed) || seed < 0)) throw Error('种子必须是非负安全整数。');
  return { references, description, mapping, style, size, seed };
}
export function composeReferencePrompt(input) {
  const c = normalizeComposition(input), has = role => c.references.some(ref => ref.role === role);
  const lines = ['依据下列参考分工，生成一幅完整的单幅画面。'];
  for (const [index, ref] of c.references.entries()) {
    const roles = {
      person: `人物 A 的脸型、五官、肤色和发型${has('outfit') ? '；服装由专门的服装参考决定' : '，并沿用其服装'}。`,
      personB: '人物 B 的脸型、五官、肤色、发型与服装；与人物 A 保持独立，不混合身份。',
      outfit: '仅提供人物 A 的服装款式、颜色、面料和配饰，不继承服装图中模特的身份、体型或背景。',
      pose: '仅提供姿态、身体朝向、机位、景别、人物画面占比与遮挡关系，不继承参考人物的脸、服装或灰色白模外观。',
      scene: '仅提供环境结构、材质、色彩、道具与光照；根据当前机位和景别呈现对应局部，不强行展示全景。'
    };
    lines.push(`图${index + 1}：${roles[ref.role]} 参考名称：${ref.name}。`);
  }
  lines.push(has('personB') ? `画面中仅有两位不同人物。对应关系：${c.mapping}` : '画面中仅有人物 A 一位人物。人物设定板中的多个视角属于同一个人，不复制为多个人物。');
  lines.push(`输出画幅 ${c.size.replace('x', '×')}。保持合理的头身比、肢体长度与空间尺度；调整取景和留白，不机械拉伸人物。`);
  lines.push(styleText[c.style]);
  if (c.description) lines.push('本次画面要求：' + c.description);
  lines.push('仅生成一幅图，不制作参考拼图、多视图排版，不添加字幕或水印。');
  return lines.join('\n');
}
