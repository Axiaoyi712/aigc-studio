import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { templates, parseRequest, compileGraph, loadGraph, checkGraph } from '../workflows.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const request = id => parseRequest({ template: id, prompt: 'A quiet lakeside cabin.', images: Array(templates.find(item => item.id === id).images).fill('uploaded-image.png'), seed: 42, size: '512x512' });

test('two reference images reach exactly two latent conditioning nodes with no third-image dependency', async () => {
  const input = { ...request('flux-2ref'), images:['role-a.png','role-b.png'] };
  const graph = compileGraph(await loadGraph(root,input.template),input,'two-roles');
  assert.deepEqual([graph['4'].inputs.image,graph['19'].inputs.image],input.images);
  assert.equal(Object.values(graph).filter(node=>node.class_type==='ReferenceLatent').length,2);
  assert.deepEqual(graph['10'].inputs.conditioning,['22',0]);
  for(const id of ['23','24','25','26'])assert.equal(graph[id],undefined);
  for(const node of Object.values(graph))for(const value of Object.values(node.inputs))if(Array.isArray(value)&&typeof value[0]==='string')assert.ok(graph[value[0]],value[0]);
});

for (const [frames, square, portrait, balanced] of [[73, 960, [736, 1280], 480], [124, 768, [576, 1024], 480], [175, 640, [480, 864], 448], [243, 544, [416, 736], 384], [362, 448, [352, 608], 320]]) test(`${frames}-frame native high resolution reaches the sampler and balanced settings remain selectable`, async () => {
  for (const template of ['h3-fast', 'h3-base', 'h3-keyframes']) {
    for (const [aspect, expected] of [['square', [square, square]], ['portrait', portrait], ['landscape', [...portrait].reverse()]]) {
      const input = parseRequest({ ...request(template), video: { frames, profile: 'high', aspect } });
      const graph = compileGraph(await loadGraph(root, template), input, 'high');
      assert.equal(graph['9'].inputs.length, frames);
      const scale = Object.values(graph).find(node => node.class_type === 'ImageScale');
      assert.deepEqual([scale.inputs.width, scale.inputs.height], expected);
      assert.ok(expected.every(value => value % 32 === 0));
      assert.equal(Object.values(graph).filter(node => node.class_type === 'ImageScale').length, 1);
      const standard = parseRequest({ ...request(template), video: { frames, profile: 'standard', aspect: 'square' } });
      const standardGraph = compileGraph(await loadGraph(root, template), standard, 'balanced');
      assert.equal(Object.values(standardGraph).find(node => node.class_type === 'ImageScale').inputs.width, balanced);
    }
    const source = parseRequest({ ...request(template), video: { frames, profile: 'high', aspect: 'source' } });
    const graph = compileGraph(await loadGraph(root, template), source, 'source');
    const scale = Object.values(graph).find(node => node.class_type === 'ImageScaleToTotalPixels');
    assert.equal(scale.inputs.resolution_steps, 32);
    assert.equal(scale.inputs.megapixels, square * square / 1e6);
  }
});

for (const frames of [243, 362]) test(`${frames}-frame videos use the H3 frame grid and reduced canvases in every video recipe`, async () => {
  const sizes = frames === 243 ? { square: [320, 320], portrait: [256, 416], landscape: [416, 256] } : { square: [288, 288], portrait: [224, 384], landscape: [384, 224] };
  for (const template of ['h3-fast', 'h3-base', 'h3-keyframes']) {
    for (const [aspect, expected] of Object.entries(sizes)) {
      const input = parseRequest({ ...request(template), video: { frames, profile: 'draft', aspect } });
      const graph = compileGraph(await loadGraph(root, template), input, 'long-video');
      assert.equal(graph['9'].inputs.length, frames);
      assert.equal(graph['9'].inputs.length % 17, 5);
      assert.equal(Object.values(graph).find(node => node.class_type === 'CreateVideo').inputs.fps, 24);
      const scale = Object.values(graph).find(node => node.class_type === 'ImageScale');
      assert.deepEqual([scale.inputs.width, scale.inputs.height], expected);
      assert.equal(scale.inputs.crop, 'center');
    }
    const input = parseRequest({ ...request(template), video: { frames, profile: 'draft', aspect: 'source' } });
    const graph = compileGraph(await loadGraph(root, template), input, 'long-source');
    const scale = Object.values(graph).find(node => node.class_type === 'ImageScaleToTotalPixels');
    assert.equal(scale.inputs.resolution_steps, 32);
    assert.equal(scale.inputs.megapixels, frames === 243 ? 0.1024 : 0.082944);
  }
  assert.throws(() => parseRequest({ ...request('h3-fast'), video: { frames, profile: 'unknown' } }), /规格/);
});

test('video settings change the executed graph and two keyframes reach separate conditioning inputs', async () => {
  const input = parseRequest({ ...request('h3-keyframes'), images: ['first.png', 'last.png'], video: { frames: 175, profile: 'draft', aspect: 'portrait', sound: 'mute', camera: 'push' } });
  const graph = compileGraph(await loadGraph(root, input.template), input, 'settings');
  assert.equal(graph['9'].inputs.length, 175);
  assert.match(graph['9'].inputs.prompt, /camera push in/);
  assert.deepEqual(graph['9'].inputs.last_frame, ['last_frame_image', 0]);
  assert.equal(graph.last_frame_image.inputs.image, 'last.png');
  assert.equal(graph['6'].inputs.image, 'first.png');
  const scale = Object.values(graph).find(node => node.class_type === 'ImageScale');
  assert.deepEqual([scale.inputs.width, scale.inputs.height, scale.inputs.crop], [320, 512, 'center']);
  assert.ok(!Object.hasOwn(Object.values(graph).find(node => node.class_type === 'CreateVideo').inputs, 'audio'));
  assert.equal(parseRequest({ ...request('h3-fast'), video: { frames: 175 } }).video.profile, 'standard');
  assert.throws(() => parseRequest({ ...request('h3-fast'), video: { camera: '__proto__' } }), /选项/);
});

test('invalid descriptions, seeds, sizes and missing references are rejected before submission', () => {
  for (const patch of [{ prompt: '' }, { seed: -1 }, { seed: 1.5 }, { seed: Number.MAX_SAFE_INTEGER + 1 }, { images: [] }, { size: '4096x4096' }, { template: 'unknown' }]) {
    assert.throws(() => parseRequest({ ...request('h3-fast'), ...patch }));
  }
});
test('the two video recipes retain their distinct acceleration paths and a valid frame grid', async () => {
  for (const id of ['h3-fast', 'h3-base']) {
    const prompt = compileGraph(await loadGraph(root, id), request(id), 'test');
    assert.equal(prompt['9'].inputs.length % 17, 5);
    assert.equal(prompt['9'].inputs.first_frame[0], '7');
    assert.equal(prompt['9'].inputs.clip[0], '2');
    assert.equal(prompt['13'].inputs.steps, id === 'h3-fast' ? 8 : 20);
    assert.equal(Boolean(prompt['5']), id === 'h3-fast');
    assert.equal(prompt['18'].inputs['format.codec'], 'h264');
    assert.equal(prompt['18'].inputs.filename_prefix, 'aigc-studio/test');
  }
});
test('three distinct references reach three conditioning nodes and the requested dimensions', async () => {
  const input = { ...request('flux-3ref'), images: ['front.png', 'side.png', 'body.png'], size: '768x1024' };
  const prompt = compileGraph(await loadGraph(root, input.template), input, 'test');
  assert.deepEqual(['4', '19', '23'].map(id => prompt[id].inputs.image), input.images);
  assert.equal(Object.values(prompt).filter(node => node.class_type === 'ReferenceLatent').length, 3);
  assert.equal(prompt['27'].inputs.value, 768);
  assert.equal(prompt['28'].inputs.value, 1024);
});
test('single-image edits use chosen dimensions rather than silently inheriting the source size', async () => {
  const input = { ...request('flux-edit'), size: '1024x768' };
  const prompt = compileGraph(await loadGraph(root, input.template), input, 'test');
  assert.equal(prompt['14'].inputs.width, 1024);
  assert.equal(prompt['14'].inputs.height, 768);
  assert.equal(prompt['12'].inputs.width, 1024);
});
test('missing links and incompatible socket types are reported', () => {
  assert.throws(() => compileGraph({ nodes: [{ id: 1, type: 'VAEEncode', inputs: [{ name: 'pixels', link: 99 }] }], links: [] }, request('flux-edit'), 'test'), /连接/);
  const errors = checkGraph({ 1: { class_type: 'A', inputs: {} }, 2: { class_type: 'B', inputs: { image: ['1', 0] } } }, { A: { output: ['MODEL'] }, B: { input: { required: { image: ['IMAGE'] } } } });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /连接类型不符/);
});

for(const size of ['2048x2048','1536x2048','2048x1536'])test(size+' native 2K dimensions reach all image and reference generation graphs',async()=>{
  const expected=size.split('x').map(Number);
  for(const id of ['z-image','flux-edit','flux-2ref','flux-3ref']){
    const input=parseRequest({...request(id),size});
    const prompt=compileGraph(await loadGraph(root,id),input,'2k-check');
    const nodes=Object.values(prompt).filter(n=>['EmptySD3LatentImage','EmptyFlux2LatentImage','Flux2Scheduler'].includes(n.class_type));
    assert.ok(nodes.length>0);
    const numeric=v=>Array.isArray(v)?prompt[v[0]].inputs.value:v;
    for(const node of nodes)assert.deepEqual([numeric(node.inputs.width),numeric(node.inputs.height)],expected,id);
  }
});

for(const count of [4,6,10,20])test(count+' project reference images all reach the sampling conditioning chain',async()=>{
  const images=Array.from({length:count},(_,i)=>'reference-'+i+'.png');
  const input=parseRequest({template:'flux-multi',prompt:'Keep references',images,seed:43,size:'720x1280'}),graph=compileGraph(await loadGraph(root,input.template),input,'multi-check');
  const found=[];let id=graph['10'].inputs.conditioning[0];
  while(graph[id].class_type==='ReferenceLatent'){
    const c=graph[id],encoded=graph[c.inputs.latent[0]],scaled=graph[encoded.inputs.pixels[0]],image=graph[scaled.inputs.image[0]];
    assert.equal(encoded.class_type,'VAEEncode');assert.equal(image.class_type,'LoadImage');found.unshift(image.inputs.image);id=c.inputs.conditioning[0];
  }
  assert.deepEqual(found,images);assert.equal(Object.values(graph).filter(n=>n.class_type==='LoadImage').length,count);assert.equal(graph['27'].inputs.value,720);assert.equal(graph['28'].inputs.value,1280);
});
test('project multi-reference workflow rejects fewer than four and more than twenty images',()=>{
  for(const n of [3,21])assert.throws(()=>parseRequest({template:'flux-multi',prompt:'test',images:Array(n).fill('image.png')}),/4～20/);
});
