import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {parseRequest,compileGraph,loadGraph,checkGraph} from '../workflows.mjs';
import {shotPlan} from '../production.mjs';
import {normalizeVideoOptions} from '../public/video-options.js';
const root=fileURLToPath(new URL('../',import.meta.url));
test('depth frames control both sampler and scheduler, keep first frame and trim only temporal padding',async()=>{
 const input=parseRequest({template:'h3-depth',driverClipId:'registered-id',images:['confirmed.png'],prompt:'保持角色，按深度片段运动',video:{delivery:'720p'}});
 const graph=compileGraph(await loadGraph(root,input.template),{...input,driver:{file:'AIGC项目/example/depth.mp4',width:384,height:512,frames:73,effectiveFrames:68}},'depth');
 assert.deepEqual(graph['10'].inputs.model,['depth_control',0]);assert.deepEqual(graph['13'].inputs.model,['depth_control',0]);
 assert.deepEqual(graph.depth_control.inputs.control_video,['depth_components',0]);assert.deepEqual(graph.depth_control.inputs.vae,['3',0]);
 assert.deepEqual(graph['9'].inputs.first_frame,['7',0]);assert.equal(graph['9'].inputs.length,73);
 assert.equal(graph.depth_trim.inputs.length,68);assert.deepEqual(graph['17'].inputs.images,['depth_trim',0]);assert.equal(graph['17'].inputs.audio,undefined);
 assert.equal(graph['7'].inputs.width,384);assert.equal(graph['7'].inputs.height,512);assert.equal(graph['7'].inputs.crop,'disabled');
 assert.equal(graph.depth_load.inputs.file,'AIGC项目/example/depth.mp4 [output]');
 assert.throws(()=>compileGraph(awaitGraph,{...input,driver:{frames:500}},'bad'),/驱动片段/);
});
const awaitGraph={nodes:[],links:[]};
test('registered output videos bypass filename dropdown only, not missing-node validation',()=>{
 const graph={v:{class_type:'LoadVideo',inputs:{file:'registered.mp4 [output]'}}};
 assert.deepEqual(checkGraph(graph,{LoadVideo:{input:{required:{file:[[]]}},output:['VIDEO']}}),[]);
 assert.match(checkGraph(graph,{}).join(''),/缺少节点/);
});
test('driver first-frame mapping shifts assets exactly once and changes invalidate its generated history',()=>{
 const assets=[{id:'a',name:'角色定稿',category:'character'}],shot={id:'s',generalPrompt:'角色坐下',referenceIds:['a'],driver:{fingerprint:'clip-a',width:384,height:512}},p={shots:[shot],videoTemplate:'h3-fast',video:{delivery:'720p'}};
 const plan=shotPlan(p,shot,assets);assert.equal(plan.size,'768x1024');assert.match(plan.imagePrompt,/参考图1是深度白膜/);assert.match(plan.imagePrompt,/参考图 2：角色定稿/);assert.equal(plan.errors.length,0);
 assert.notEqual(shotPlan(p,{...shot,driver:{...shot.driver,fingerprint:'clip-b'}},assets).frameSignature,plan.frameSignature);
 assert.equal(shotPlan({...p,video:{delivery:'1080p'}},shot,assets).videoSignature,plan.videoSignature);
 const old=normalizeVideoOptions({});assert.equal(Object.hasOwn(old,'delivery'),false);assert.throws(()=>normalizeVideoOptions({delivery:'4K'}),/清晰度/);
});
