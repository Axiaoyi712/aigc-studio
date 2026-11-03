export const cameras = { none: '自定义（以正文为准）', static: '固定镜头', push: '缓慢推近', pull: '缓慢拉远', left: '向左平移', right: '向右平移', panLeft: '向左摇镜', panRight: '向右摇镜', follow: '平稳跟随', orbit: '轻微环绕' };
export const actions = { none: '自定义动作', blink: '眨眼与呼吸', look: '轻微转头', hair: '微风与发丝', walk: '缓慢行走' };
export const styles = { preserve: '保持原图风格', film: '电影感光影', anime: '动画插画', product: '产品展示' };
export const videoDurations = { 73: '约 3.04 秒', 124: '约 5.17 秒 · 默认', 175: '约 7.29 秒', 243: '约 10.13 秒', 362: '约 15.08 秒' };
export function normalizeVideoOptions(value = {}) {
  const video = { frames: Number(value.frames ?? 124), profile: value.profile ?? 'standard', aspect: value.aspect ?? 'source', sound: value.sound ?? 'keep', camera: value.camera ?? 'none', action: value.action ?? 'none', style: value.style ?? 'preserve', shot: value.shot ?? 'none', pace: value.pace ?? 'none' };
  if (!Object.hasOwn(videoDurations, video.frames)) throw Error('请选择提供的视频时长。');
  if (!['draft', 'standard', 'high'].includes(video.profile) || !['source', 'square', 'portrait', 'landscape'].includes(video.aspect) || !['keep', 'mute'].includes(video.sound)) throw Error('视频规格无效。');
  if (!Object.hasOwn(cameras, video.camera) || !Object.hasOwn(actions, video.action) || !Object.hasOwn(styles, video.style) || !['none', 'close', 'medium', 'wide'].includes(video.shot) || !['none', 'slow', 'normal'].includes(video.pace)) throw Error('视频提示词选项无效。');
  return video;
}
export function videoCanvas(video) {
  if (video.profile === 'high') {
    const [square, portrait] = video.frames <= 73 ? [960, [736, 1280]] : video.frames <= 124 ? [768, [576, 1024]] : video.frames <= 175 ? [640, [480, 864]] : video.frames <= 243 ? [544, [416, 736]] : [448, [352, 608]];
    return { square: [square, square], portrait, landscape: [...portrait].reverse(), megapixels: square * square / 1e6 };
  }
  if (video.profile === 'standard' && video.frames >= 175) {
    const [square, portrait] = video.frames <= 175 ? [448, [352, 576]] : video.frames <= 243 ? [384, [288, 512]] : [320, [256, 416]];
    return { square: [square, square], portrait, landscape: [...portrait].reverse(), megapixels: square * square / 1e6 };
  }
  if (video.frames >= 362) return { square: [288, 288], portrait: [224, 384], landscape: [384, 224], megapixels: 0.082944 };
  if (video.frames >= 243) return { square: [320, 320], portrait: [256, 416], landscape: [416, 256], megapixels: 0.1024 };
  return video.profile === 'draft'
    ? { square: [384, 384], portrait: [320, 512], landscape: [512, 320], megapixels: 0.15 }
    : { square: [480, 480], portrait: [384, 640], landscape: [640, 384], megapixels: 0.23 };
}
export function videoResolutionLabel(video) {
  const canvas = videoCanvas(video);
  return video.aspect === 'source' ? `约 ${Math.round(canvas.megapixels * 100)} 万像素 · 跟随首帧` : canvas[video.aspect].join('×');
}
export function videoProfileLabels(video) {
  return Object.fromEntries(Object.entries({ draft: '省显存', standard: '均衡', high: '高分辨率' }).map(([profile, title]) => [profile, `${title} · ${videoResolutionLabel({ ...video, profile })}`]));
}
export function composeVideoPrompt(base, options) {
  const video = normalizeVideoOptions(options);
  const camera = { static: 'Static camera.', push: 'Slow smooth camera push in.', pull: 'Slow smooth camera pull back.', left: 'Slow smooth camera truck to the left.', right: 'Slow smooth camera truck to the right.', panLeft: 'Slow smooth camera pan to the left.', panRight: 'Slow smooth camera pan to the right.', follow: 'Smooth camera following the subject.', orbit: 'A very small smooth camera orbit around the subject.' };
  const action = { blink: 'Gentle blinking and breathing.', look: 'Very slight natural head turn.', hair: 'A soft breeze gently moves hair and fabric.', walk: 'The subject walks slowly with natural motion.' };
  const style = { film: 'Cinematic lighting and coherent film colors.', anime: 'Consistent animated illustration style.', product: 'Clean product presentation with controlled lighting.' };
  const shot = { close: 'Close-up framing.', medium: 'Medium shot framing.', wide: 'Wide shot framing.' };
  return [base.trim(), camera[video.camera], action[video.action], style[video.style], shot[video.shot], video.pace === 'slow' ? 'Slow restrained motion.' : video.pace === 'normal' ? 'Natural motion at a normal pace.' : ''].filter(Boolean).join('\n');
}
export function adaptForH3(body) {
  return body.replace(/即梦\s*[\d.]*|Seedance\s*[\d.]*|Sora\s*[\d.]*|Wan\s*[\d.]*|GPT\s*Image\s*[\d.]*/gi, '').replace(/\d+(?:\.\d+)?\s*(?:厘米|米|cm|m)\s*[/／]\s*帧/gi, '缓慢平稳').replace(/100%锁脸|绝对不变|保证不崩坏|严格锁定/g, '尽量保持一致').replace(/，\s*，/g, '，').trim();
}
