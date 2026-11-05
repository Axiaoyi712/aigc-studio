import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { normalizeVideoOptions, composeVideoPrompt, videoCanvas } from './public/video-options.js';

export const templates = [
  { id: 'h3-fast', section: 'video', name: 'H3 · 快速 8 步', file: 'h3-fast.json', source: '视频-01-MiniMax-H3图生视频-8GB测试版.json', images: 1, steps: 8, description: '单张首帧 · 约 5.17 秒 · 原生音频', defaultPrompt: 'A single continuous shot based on the input image. Preserve the subject, appearance, outfit, lighting and background. Static camera, gentle natural movement, no scene cuts, no text. Audio: quiet ambient sound, no speech.' },
  { id: 'h3-base', section: 'video', name: 'H3 · 基础 20 步', file: 'h3-base.json', source: '视频-02-MiniMax-H3图生视频-20步质量版.json', images: 1, steps: 20, description: '移除加速 LoRA · 耗时更长，效果需对比', defaultPrompt: 'A single continuous shot based on the input image. Preserve the subject, appearance, outfit, lighting and background. Static camera, gentle natural movement, no scene cuts, no text. Audio: quiet ambient sound, no speech.' },
  { id: 'z-image', section: 'image', name: 'Z-Image · 文字生成图片', file: 'z-image.json', source: '文生图模板.json', images: 0, steps: 8, description: '描述画面 · 生成一张图片', defaultPrompt: '一座湖边的小木屋，清晨薄雾，远山与松树，自然光，细腻的插画风格，安静的氛围。' },
  { id: 'flux-edit', section: 'image', name: 'FLUX Klein · 单图编辑', file: 'flux-edit.json', source: '图生图-01-FLUX-Klein4B-8GB.json', images: 1, steps: 4, description: '上传一张图片 · 描述希望修改的内容', defaultPrompt: '保留原图主体、外观和构图，将背景改为简洁的浅灰色摄影棚，自然柔和的光线，保留服装与细节。' },
  { id: 'flux-3ref', section: 'reference', name: 'FLUX Klein · 三图参考', file: 'flux-3ref.json', source: '图生图-02-FLUX-Klein三图参考-8GB.json', images: 3, steps: 4, description: '正面、侧面、全身参考 · 生成候选首帧', defaultPrompt: 'Create one full-body portrait of the same adult person in the three reference images. Preserve facial structure, hairstyle, body proportions and the complete outfit. Standing naturally in a softly lit studio, fully clothed, one person, no text.' }
];

templates.splice(2, 0, { ...templates[0], id: 'h3-keyframes', name: 'H3 · 首尾帧过渡 · 8 步', source: null, images: 2, description: '上传起始与结束画面，生成中间过渡', defaultPrompt: '保持主体外观与服装一致，从首帧自然过渡到尾帧，动作连贯。' });
templates.push({ ...templates.find(item => item.id === 'flux-3ref'), id: 'flux-2ref', name: 'FLUX Klein · 双图参考', source: null, images: 2, description: '两张独立参考 · 按描述生成同场或不同视角首帧', defaultPrompt: '依据参考图保留角色五官、发型、服装和体型，按描述安排人物与场景，不互换不同角色的身份。' });
templates.push({ ...templates.find(item => item.id === 'flux-3ref'), id: 'flux-multi', name: 'FLUX Klein · 多图参考（4～20张）', source: null, images: 4, maxImages: 20, internal: true, description: '项目首帧多图参考 · 最多二十张独立图片' });
templates.push({...templates.find(item=>item.id==='h3-base'),id:'h3-reference',name:'H3 · 多参考 20 步 · 实验',source:null,images:1,maxImages:4,experimental:true,description:'独立 Ref2VA 权重 · 项目中使用角色/场景参考与分镜图 · 首帧不强制对齐',defaultPrompt:'依据参考图中的主体身份、外观与场景，生成自然连贯的短镜头。'});
templates.push({...templates.find(item=>item.id==='h3-base'),id:'h3-depth',name:'H3 · 白膜深度驱动 · 实验',source:null,internal:true,description:'已确认首帧＋逐帧深度控制；正式输出至少720p'});

const widgets = {
  UNETLoader: ['unet_name', 'weight_dtype'], CLIPLoader: ['clip_name', 'type', 'device'],
  VAELoader: ['vae_name'], LoraLoaderModelOnly: ['lora_name', 'strength_model'],
  LoadImage: ['image'], ImageScaleToTotalPixels: ['upscale_method', 'megapixels', 'resolution_steps'],
  MiniMaxH3ImageToVideo: ['prompt', 'width', 'height', 'length'],
  RandomNoise: ['noise_seed'], KSamplerSelect: ['sampler_name'],
  BasicScheduler: ['scheduler', 'steps', 'denoise'], VAEDecodeTiled: ['tile_size', 'overlap', 'temporal_size', 'temporal_overlap'],
  CreateVideo: ['fps', 'bit_depth', 'color_space', 'codec'], SaveVideo: ['filename_prefix', 'format', 'codec'],
  CLIPTextEncode: ['text'], Flux2Scheduler: ['steps', 'width', 'height'],
  EmptyFlux2LatentImage: ['width', 'height', 'batch_size'], PrimitiveInt: ['value'],
  SaveImage: ['filename_prefix'], ModelSamplingAuraFlow: ['shift', 'shift_type'],
  EmptySD3LatentImage: ['width', 'height', 'batch_size'],
  KSampler: ['seed', null, 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'],
  GetImageSize: [], VAEEncode: [], ReferenceLatent: [], BasicGuider: [],
  SamplerCustomAdvanced: [], VAEDecode: [], VAEDecodeAudio: [], PreviewImage: []
};

export function parseRequest(input) {
  const template = templates.find(item => item.id === input.template);
  if (!template) throw new Error('请选择可用的工作流。');
  const prompt = String(input.prompt ?? '').trim();
  if (!prompt || prompt.length > 6000) throw new Error('请输入 1～6000 字的画面或动作描述。');
  const images = input.images ?? [];
  if (!Array.isArray(images) || (template.maxImages ? images.length<template.images||images.length>template.maxImages : images.length !== template.images) || images.some(value => typeof value !== 'string' || !value)) throw new Error(`此工作流需要 ${template.images}${template.maxImages?'～'+template.maxImages:''} 张图片。`);
  const seed = input.seed === '' || input.seed === undefined ? Math.floor(Math.random() * 1e12) : Number(input.seed);
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('种子必须是非负安全整数。');
  const size = input.size ?? '512x512';
  if (!['512x512', '768x1024', '1024x768', '768x768', '1024x1024', '768x432', '432x768', '1024x576', '576x1024', '1280x720', '720x1280', '2048x2048', '1536x2048', '2048x1536'].includes(size)) throw new Error('请选择提供的图片尺寸。');
  if (template.section === 'video') {
    const video = normalizeVideoOptions(input.video);
    if(template.id==='h3-reference'&&(video.frames>124||video.profile!=='draft'||video.aspect==='source'))throw new Error('本机多参考实验路径仅支持约 3～5 秒、省显存档，并需明确选择横版、竖版或方形。');
    if(template.id==='h3-depth'&&typeof input.driverClipId!=='string')throw Error('请选择已准备的驱动片段。');
    return { template: template.id, prompt: input.video ? composeVideoPrompt(prompt, video) : prompt, sourcePrompt: prompt, images, seed, size, video,...(template.id==='h3-depth'?{driverClipId:input.driverClipId}:{}) };
  }
  return { template: template.id, prompt, images, seed, size };
}

export function compileGraph(graph, input, jobId) {
  const template = templates.find(item => item.id === input.template);
  if (!template) throw new Error('工作流不存在。');
  const prompt = {};
  const links = new Map(graph.links.map(link => [link[0], link]));
  let imageIndex = 0;
  const [width, height] = input.size.split('x').map(Number);
  const video = template.section === 'video' ? normalizeVideoOptions(input.video) : null;
  for (const node of graph.nodes) {
    if (node.type === 'Note') continue;
    const fields = widgets[node.type];
    if (!fields) throw new Error(`尚未适配节点 ${node.type}，请先更新工作流适配。`);
    const values = node.widgets_values ?? [];
    const inputs = {};
    fields.forEach((name, i) => { if (name && values[i] !== undefined) inputs[name] = values[i]; });
    if (node.type === 'LoadImage') inputs.image = input.images[imageIndex++];
    if (node.type === 'CLIPTextEncode' && (inputs.text || template.id === 'flux-edit')) inputs.text = input.prompt;
    if (node.type === 'MiniMaxH3ImageToVideo') { inputs.prompt = input.prompt; inputs.length = video.frames; }
    if (node.type === 'RandomNoise') inputs.noise_seed = input.seed;
    if (node.type === 'KSampler') inputs.seed = input.seed;
    if (node.type === 'CLIPLoader' && template.id === 'z-image') inputs.type = 'lumina2';
    if (node.type === 'SaveImage' || node.type === 'SaveVideo') inputs.filename_prefix = input.storagePrefix || `aigc-studio/${jobId}`;
    if (node.type === 'SaveVideo') { inputs.format = 'mp4'; inputs['format.codec'] = 'h264'; inputs.codec = 'h264'; }
    if (template.section !== 'video') {
      if (['EmptyFlux2LatentImage', 'EmptySD3LatentImage', 'Flux2Scheduler'].includes(node.type)) Object.assign(inputs, { width, height });
      if (node.type === 'PrimitiveInt') inputs.value = Number(node.id) === 27 ? width : height;
    }
    // Match links by their named input, since the saved UI slot order can change between releases.
    for (const socket of node.inputs ?? []) {
      if (socket.link === null || socket.link === undefined) continue;
      if (template.id === 'flux-edit' && ['EmptyFlux2LatentImage', 'Flux2Scheduler'].includes(node.type) && ['width', 'height'].includes(socket.name)) continue;
      const link = links.get(socket.link);
      if (!link) throw new Error(`节点 ${node.id} 的连接 ${socket.link} 缺失。`);
      inputs[socket.name] = [String(link[1]), link[2]];
    }
    if (video && node.type === 'ImageScaleToTotalPixels') {
      const canvas = videoCanvas(video);
      if (video.aspect === 'source') {
        inputs.megapixels = canvas.megapixels;
        if (video.frames >= 243 || video.profile === 'high' || (video.profile === 'standard' && video.frames >= 175)) inputs.resolution_steps = 32;
      }
      else {
        const [w, h] = canvas[video.aspect];
        prompt[node.id] = { class_type: 'ImageScale', inputs: { image: inputs.image, upscale_method: 'lanczos', width: w, height: h, crop: 'center' } };
        continue;
      }
    }
    if (video?.sound === 'mute' && node.type === 'CreateVideo') delete inputs.audio;
    prompt[node.id] = { class_type: node.type, inputs };
  }
  if(template.id==='h3-depth'){
    const c=input.driver;
    if(!c||!Number.isInteger(c.frames)||c.frames<39||c.frames>141||(c.frames-5)%17||!Number.isInteger(c.effectiveFrames)||c.effectiveFrames<1||c.effectiveFrames>c.frames||![c.width,c.height].every(v=>Number.isInteger(v)&&v>=64&&v<=1536&&v%32===0))throw Error('驱动片段规格无效。');
    prompt['7']={class_type:'ImageScale',inputs:{image:['6',0],upscale_method:'lanczos',width:c.width,height:c.height,crop:'disabled'}};
    prompt['9'].inputs.length=c.frames;
    prompt.depth_load={class_type:'LoadVideo',inputs:{file:c.file+' [output]'}};
    prompt.depth_components={class_type:'GetVideoComponents',inputs:{video:['depth_load',0]}};
    prompt.depth_patch={class_type:'ModelPatchLoader',inputs:{name:'minimax_h3_fun_controlnet_union_pruned_int8_convrot.safetensors'}};
    prompt.depth_control={class_type:'MiniMaxH3FunControlNetApply',inputs:{model:['1',0],model_patch:['depth_patch',0],vae:['3',0],strength:1,start_percent:0,end_percent:1,control_video:['depth_components',0]}};
    prompt['10'].inputs.model=['depth_control',0];prompt['13'].inputs.model=['depth_control',0];
    prompt.depth_trim={class_type:'ImageFromBatch',inputs:{image:['15',0],batch_index:0,length:c.effectiveFrames}};
    prompt['17'].inputs.images=['depth_trim',0];delete prompt['17'].inputs.audio;
  }
  if (template.id === 'h3-keyframes') {
    prompt.last_frame_image = { class_type: 'LoadImage', inputs: { image: input.images[1] } };
    prompt['9'].inputs.last_frame = ['last_frame_image', 0];
  }
  if(template.id==='h3-reference'){
    for(const id of ['6','7','8'])delete prompt[id];
    const canvas=videoCanvas({...video,aspect:video.aspect==='source'?'landscape':video.aspect});
    const [width,height]=canvas[video.aspect==='source'?'landscape':video.aspect];
    prompt['1'].inputs.unet_name='minimax_h3_ref2va_pruned_w6a8.safetensors';
    const inputs={clip:['2',0],vae:['3',0],audio_vae:['4',0],prompt:input.prompt,width,height,length:video.frames,ref_image_size:'match'};
    input.images.forEach((image,i)=>{const id='reference_image_'+i;prompt[id]={class_type:'LoadImage',inputs:{image}};inputs['ref_images.ref_image_'+i]=[id,0];});
    prompt['9']={class_type:'MiniMaxH3ReferenceToVideo',inputs};
  }
  if (template.id === 'flux-2ref') {
    for (const id of ['23','24','25','26']) delete prompt[id];
    prompt['10'].inputs.conditioning = ['22', 0];
  }
  if (template.id === 'flux-multi') {
    let previous = '26';
    for (let i = 3; i < input.images.length; i++) {
      const image = `ref_${i + 1}_image`, scale = `ref_${i + 1}_scale`, encode = `ref_${i + 1}_encode`, condition = `ref_${i + 1}_condition`;
      prompt[image] = { class_type: 'LoadImage', inputs: { image: input.images[i] } };
      prompt[scale] = { class_type: 'ImageScaleToTotalPixels', inputs: { ...prompt['20'].inputs, image: [image, 0] } };
      prompt[encode] = { class_type: 'VAEEncode', inputs: { vae: prompt['21'].inputs.vae, pixels: [scale, 0] } };
      prompt[condition] = { class_type: 'ReferenceLatent', inputs: { conditioning: [previous, 0], latent: [encode, 0] } };
      previous = condition;
    }
    prompt['10'].inputs.conditioning = [previous, 0];
  }
  return prompt;
}

export async function loadGraph(root, templateId) {
  const template = templates.find(item => item.id === templateId);
  if (!template) throw new Error('工作流不存在。');
  return JSON.parse(await readFile(resolve(root, 'workflows', template.file), 'utf8'));
}

export function checkGraph(prompt, info) {
  const errors = [];
  for (const [id, node] of Object.entries(prompt)) {
    const schema = info[node.class_type];
    if (!schema) { errors.push(`缺少节点 ${node.class_type}`); continue; }
    for (const [name, definition] of Object.entries(schema.input?.required ?? {})) {
      if (!(name in node.inputs)) errors.push(`${id}.${name} 缺少必要参数`);
    }
    for (const [name, value] of Object.entries(node.inputs)) {
      const definition = schema.input?.required?.[name] ?? schema.input?.optional?.[name] ?? (node.class_type==='MiniMaxH3ReferenceToVideo'&&name.startsWith('ref_images.')?['IMAGE']:undefined);
      if (!definition) continue;
      if (Array.isArray(value)) {
        const source = prompt[value[0]];
        if (!source) { errors.push(`${id}.${name} 引用了缺失节点`); continue; }
        const output = info[source.class_type]?.output?.[value[1]];
        const expected = definition[0];
        if (typeof expected === 'string' && !['COMBO', 'COMFY_DYNAMICCOMBO_V3'].includes(expected) && output !== expected) errors.push(`${id}.${name} 的连接类型不符：${output} / ${expected}`);
      } else if (Array.isArray(definition[0]) && !definition[0].includes(value) && !['LoadImage','LoadVideo'].includes(node.class_type)) {
        errors.push(`${id}.${name} 的模型或选项不可用：${value}`);
      }
    }
  }
  return errors;
}
