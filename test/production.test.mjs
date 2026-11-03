import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProduction, normalizeDirector, imageSize } from '../public/director-options.js';
import { shotPlan, frameMatches, videoMatches, validateEdit } from '../production.mjs';
import { primaryOutput } from '../media.mjs';
import { parseRequest, compileGraph, loadGraph } from '../workflows.mjs';
import { fileURLToPath } from 'node:url';

test('general prompt overrides detailed shot fields while keeping project style and character references',()=>{
  const assets=[{id:'a',name:'角色原图',category:'character'}];
  const shot={id:'s',generalPrompt:'林夏坐在窗边，端起水杯，镜头缓慢推近，雨声，没有配乐。',imagePrompt:'旧首帧',videoPrompt:'旧动作',referenceIds:[],director:normalizeDirector({camera:'static',position:'旧站位',sound:'旧声音',music:'旧音乐',wardrobe:'旧服装'})};
  const project={shots:[shot],production:normalizeProduction({style:'电影感',location:'餐厅'}),characters:[{id:'r',name:'林夏',description:'黑色长发',referenceIds:['a']}],video:{aspect:'portrait',frames:243},videoTemplate:'h3-fast'};
  const plan=shotPlan(project,shot,assets);
  assert.deepEqual(plan.errors,[]);assert.equal(plan.promptMode,'general');assert.deepEqual(plan.referenceIds,['a']);assert.equal(plan.video.frames,243);
  assert.match(plan.imagePrompt,/一张静态首帧/);assert.match(plan.imagePrompt,/林夏/);assert.match(plan.imagePrompt,/电影感/);assert.match(plan.imagePrompt,/黑色长发/);
  assert.match(plan.videoPrompt,/端起水杯/);assert.match(plan.videoPrompt,/雨声/);assert.doesNotMatch(plan.imagePrompt+plan.videoPrompt,/旧首帧|旧动作|旧站位|旧声音|旧音乐|旧服装|camera holds still/);
  const ignored=shotPlan(project,{...shot,imagePrompt:'另一个首帧',director:normalizeDirector({camera:'orbit'})},assets);
  assert.equal(ignored.frameSignature,plan.frameSignature);assert.equal(ignored.videoSignature,plan.videoSignature);
  const changed=shotPlan(project,{...shot,generalPrompt:'林夏站起身。'},assets);assert.notEqual(changed.frameSignature,plan.frameSignature);assert.notEqual(changed.videoSignature,plan.videoSignature);
  assert.deepEqual(shotPlan(project,{...shot,generalPrompt:''},assets),shotPlan(project,{...shot,generalPrompt:undefined},assets));
  assert.equal(shot.director.wardrobe,'旧服装');assert.equal(shot.imagePrompt,'旧首帧');
});

test('general prompt alone supplies both stages and Ref2VA keeps its own reference limit',()=>{
  const shot={id:'s',generalPrompt:'湖边小屋，湖水轻轻起伏，自然环境声。',referenceIds:[]};
  const project={shots:[shot],videoTemplate:'h3-fast'};
  assert.deepEqual(shotPlan(project,shot,[]).errors,[]);
  const legacy={...shot,generalPrompt:undefined,imagePrompt:'小屋',videoPrompt:'水面起伏'};
  const empty={...legacy,generalPrompt:'   '};
  assert.deepEqual(shotPlan(project,legacy,[]),shotPlan(project,empty,[]));
  assert.equal(shotPlan(project,legacy,[]).frameSignature,null);
});

test('saved output is preferred without renumbering preview and download URLs',()=>{
  const job={outputs:[{index:0,type:'temp',kind:'image'},{index:1,type:'output',kind:'image'}]};
  assert.equal(primaryOutput(job).index,1);assert.equal(job.outputs[0].index,0);
});
test('project image dimensions enter the real single/two/three-reference and text-image graphs',async()=>{
  const root=fileURLToPath(new URL('../',import.meta.url));
  for(const [aspect,size] of [['landscape','1024x576'],['portrait','576x1024'],['square','768x768']]){
    const project={production:normalizeProduction(),video:{aspect}};assert.equal(imageSize(project),size);
    for(const [template,n] of [['z-image',0],['flux-edit',1],['flux-2ref',2],['flux-3ref',3]]){
      const input=parseRequest({template,prompt:'原始构图',size,images:Array(n).fill('image.png')});
      const graph=compileGraph(await loadGraph(root,template),input,'dimensions');
      const dims=Object.values(graph).filter(x=>['EmptyFlux2LatentImage','EmptySD3LatentImage','Flux2Scheduler'].includes(x.class_type));
      const numeric=v=>Array.isArray(v)?graph[v[0]].inputs.value:v;
      for(const node of dims)assert.deepEqual([numeric(node.inputs.width),numeric(node.inputs.height)],size.split('x').map(Number));
    }
  }
});
test('visual changes invalidate frames, motion only invalidates videos, editing changes preserve both',()=>{
  const shot={id:'s1',imagePrompt:'青年站在店外',videoPrompt:'青年抬头',referenceIds:[],confirmedFrameJobId:'frame',director:normalizeDirector({camera:'push',sound:'雨声'})};
  const project={shots:[shot],production:normalizeProduction({style:'电影光影'}),video:{aspect:'landscape'},videoTemplate:'h3-fast'};
  const plan=shotPlan(project,shot,[]);assert.match(plan.videoPrompt,/camera pushes in/);assert.match(plan.videoPrompt,/雨声/);
  const image={id:'frame',status:'success',frameSignature:plan.frameSignature,outputs:[{kind:'image'}]};
  const video={status:'success',frameJobId:'frame',videoSignature:plan.videoSignature,outputs:[{kind:'video'}]};
  assert.ok(frameMatches(project,shot,image,[]));assert.ok(videoMatches(project,shot,video,[]));
  project.production.exportSize='1920x1080';assert.ok(videoMatches(project,shot,video,[]));
  shot.director.action='青年低头';assert.ok(frameMatches(project,shot,image,[]));assert.ok(!videoMatches(project,shot,video,[]));
  project.production.lighting='右侧暖光';assert.ok(!frameMatches(project,shot,image,[]));
});
test('reference overflow, camera conflicts, continuity and exclusive trim end are validated',()=>{
  const assets=Array.from({length:21},(_,i)=>({id:i+1,name:'图'+(i+1),category:'scene'}));
  const shot={id:'s2',imagePrompt:'门口',videoPrompt:'相机跟随',referenceIds:[21],director:normalizeDirector({camera:'static',start:{holding:'左手'}})};
  const project={shots:[{id:'s1',director:normalizeDirector({end:{holding:'右手'}})},shot],production:normalizeProduction({referenceIds:assets.slice(0,20).map(a=>a.id)},assets)};
  const plan=shotPlan(project,shot,assets);assert.match(plan.errors.join(''),/超过 20/);assert.equal(plan.warnings.length,2);
  assert.throws(()=>validateEdit({inFrame:10,outFrame:9}),/范围/);
  assert.throws(()=>validateEdit({outFrame:125},{id:'v',outputs:[{metadata:{frame_count:124}}]}),/范围/);
  assert.equal(validateEdit({inFrame:24,outFrame:72}).outFrame-24,48);
});
test('Ref2VA uses distinct checkpoint and real reference-conditioning sockets instead of extra upload decorations',async()=>{
  const root=fileURLToPath(new URL('../',import.meta.url));
  const input=parseRequest({template:'h3-reference',prompt:'主体与场景按参考保持',images:['role.png','scene.png','layout.png'],video:{frames:73,profile:'draft',aspect:'landscape'}});
  const graph=compileGraph(await loadGraph(root,input.template),input,'refs');
  assert.match(graph['1'].inputs.unet_name,/ref2va/);assert.equal(graph['9'].class_type,'MiniMaxH3ReferenceToVideo');
  assert.equal(graph['9'].inputs.first_frame,undefined);assert.equal(graph['9'].inputs.ref_image_size,'match');
  assert.equal(Object.values(graph).filter(n=>n.class_type==='LoadImage').length,3);
  for(let i=0;i<3;i++)assert.equal(graph[graph['9'].inputs['ref_images.ref_image_'+i][0]].inputs.image,input.images[i]);
  assert.throws(()=>parseRequest({...input,images:Array(5).fill('x')}),/需要/);
});
