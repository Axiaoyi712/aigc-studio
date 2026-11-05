import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {resolve} from 'node:path';import {randomUUID} from 'node:crypto';
import {createUpscaler} from '../upscale.mjs';import {createStorage} from '../storage.mjs';import {primaryOutput,requireMedia} from '../media.mjs';
function harness(t){
 const dir=mkdtempSync(resolve(tmpdir(),'aigc-upscale-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const config={comfyRoot:resolve(dir,'comfy'),projectStorage:true};mkdirSync(resolve(config.comfyRoot,'models/upscale_models'),{recursive:true});writeFileSync(resolve(config.comfyRoot,'models/upscale_models/RealESRGAN_x2plus.pth'),'model fixture');mkdirSync(resolve(config.comfyRoot,'output/aigc-studio'),{recursive:true});writeFileSync(resolve(config.comfyRoot,'output/aigc-studio/source.mp4'),'original bytes');
 const shot={id:randomUUID(),title:'镜头',videoHistory:[],imageHistory:[],videoJobId:null,referenceIds:[]},project={id:randomUUID(),name:'测试',shots:[shot],characters:[]};
 const source={id:randomUUID(),template:'h3-fast',section:'video',title:'原片',status:'success',projectId:project.id,shotId:shot.id,frameJobId:randomUUID(),characterSignature:'character',frameSignature:'frame',videoSignature:'video',outputs:[{index:0,type:'output',kind:'video',filename:'source.mp4',subfolder:'aigc-studio'}]};shot.videoJobId=source.id;shot.videoHistory.push(source.id);
 const state={jobs:[source],projects:[project],assets:[],uploads:{},exports:[]},storage=createStorage(config,state,resolve(dir,'data')),events=[];let child,args,busy=false;
 const controller=createUpscaler({state,config,appRoot:dir,save:()=>storage.sync(),send:(res,status,data)=>Object.assign(res,{status,data}),readBody:async()=>Buffer.from('{}'),probeSource:async()=>({width:512,height:320,fps:24}),json:async(path)=>{events.push(path);return path==='/queue'?{queue_running:[],queue_pending:[]}:{};},post:async path=>events.push(path),publicJob:j=>structuredClone(j),isBusy:()=>busy,release:async()=>events.push('release'),spawnProcess:(exe,argv)=>{args=argv;child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>queueMicrotask(()=>child.emit('close',null));return child;}});
 const request=async(id,operation='upscale',method='POST')=>{const res={};await controller.handle({method},res,new URL('http://localhost/api/jobs/'+id+'/'+operation));return res;};
 return {dir,config,state,source,shot,controller,request,events,setBusy:v=>busy=v,get child(){return child;},get args(){return args;}};
}
test('upscale keeps original bytes and selected version, reports progress, adds a selectable independent history and compares both',async t=>{
 const h=harness(t);const response=await h.request(h.source.id);assert.equal(response.status,202);const job=h.state.jobs[0];assert.equal(job.status,'running');assert.equal(h.controller.busy(),true);assert.deepEqual(h.events,['/queue','release','/free']);assert.equal(h.args[2],requireMedia(h.config,primaryOutput(h.source)));
 h.child.stdout.emit('data',Buffer.from('{"progress":{"value":1,"max":48}}\n'));assert.deepEqual(job.progress,{value:1,max:48});assert.equal(h.shot.videoJobId,h.source.id);
 writeFileSync(h.args[3],'enhanced bytes');h.child.stdout.emit('data',Buffer.from('{"metadata":{"width":1920,"height":1080,"frame_count":48,"fps":24,"audio":true}}\n'));h.child.emit('close',0);
 assert.equal(h.controller.busy(),false);assert.equal(job.status,'success');assert.equal(job.frameJobId,h.source.frameJobId);assert.equal(job.videoSignature,h.source.videoSignature);assert.equal(h.shot.videoJobId,h.source.id);assert.ok(h.shot.videoHistory.includes(job.id));assert.equal(readFileSync(requireMedia(h.config,primaryOutput(h.source)),'utf8'),'original bytes');assert.equal(readFileSync(requireMedia(h.config,primaryOutput(job)),'utf8'),'enhanced bytes');assert.match(job.outputs[0].subfolder,/AIGC项目/);
 const count=h.state.jobs.length;const repeated=await h.request(h.source.id);assert.equal(repeated.data.id,job.id);assert.equal(h.state.jobs.length,count);const compared=await h.request(job.id,'comparison','GET');assert.equal(compared.data.source.id,h.source.id);assert.equal(compared.data.enhanced.id,job.id);await assert.rejects(h.request(job.id),/已是精修/);
});
test('busy queues, invalid sources and missing source files cannot start refinement',async t=>{
 const h=harness(t);h.setBusy(true);await assert.rejects(h.request(h.source.id),e=>e.status===409);assert.deepEqual(h.events,[]);h.setBusy(false);h.source.outputs[0].kind='image';await assert.rejects(h.request(h.source.id),/已完成的视频/);h.source.outputs[0].kind='video';h.source.outputs[0].filename='missing.mp4';await assert.rejects(h.request(h.source.id),/素材文件缺失/);assert.equal(h.state.jobs.length,1);
});
test('cancellation preserves original and permits retry after the child exits',async t=>{
 const h=harness(t);await h.request(h.source.id);const job=h.state.jobs[0];writeFileSync(h.args[3].replace('.mp4','.partial.mp4'),'partial');await h.request(job.id,'cancel');await new Promise(ok=>setImmediate(ok));assert.equal(job.status,'cancelled');assert.equal(h.controller.busy(),false);assert.equal(existsSync(h.args[3].replace('.mp4','.partial.mp4')),false);assert.equal(readFileSync(requireMedia(h.config,primaryOutput(h.source)),'utf8'),'original bytes');await h.request(h.source.id);assert.notEqual(h.state.jobs[0].id,job.id);h.child.emit('close',1);
});
test('failed refinement does not add an unusable version or change the selected source',async t=>{
 const h=harness(t);await h.request(h.source.id);const job=h.state.jobs[0];h.child.stderr.emit('data',Buffer.from('CUDA fixture failure'));h.child.emit('close',1);assert.equal(job.status,'failed');assert.match(job.error,/CUDA/);assert.deepEqual(h.shot.videoHistory,[h.source.id]);assert.equal(h.shot.videoJobId,h.source.id);
});

test('automatic delivery requires a real720p result, selects it once and preserves source and aspect arguments',async t=>{
 const h=harness(t);h.source.video={delivery:'720p'};assert.equal(await h.controller.tick(),true);const job=h.state.jobs[0];
 assert.equal(h.source.deliveryStatus,'running');assert.deepEqual(h.args.slice(-2),['--delivery','720p']);assert.equal(job.enhancement.nativeWidth,512);
 writeFileSync(h.args[3],'real model output fixture');h.child.stdout.emit('data',Buffer.from('{"metadata":{"width":1152,"height":720,"frame_count":73}}\n'));h.child.emit('close',0);
 assert.equal(job.status,'success');assert.equal(h.source.deliveryStatus,'success');assert.equal(h.shot.videoJobId,job.id);assert.equal(await h.controller.tick(),false);
 assert.equal(readFileSync(requireMedia(h.config,primaryOutput(h.source)),'utf8'),'original bytes');
});
test('automatic delivery never marks undersized output as completed or overwrites a user-chosen version',async t=>{
 const h=harness(t);h.source.video={delivery:'720p'};await h.controller.tick();const job=h.state.jobs[0];writeFileSync(h.args[3],'undersized');
 h.child.stdout.emit('data',Buffer.from('{"metadata":{"width":640,"height":384}}\n'));h.child.emit('close',0);
 assert.equal(job.status,'failed');assert.equal(h.source.deliveryStatus,'failed');assert.equal(h.shot.videoJobId,h.source.id);
 const other=harness(t);other.source.video={delivery:'720p'};await other.controller.tick();const hd=other.state.jobs[0];other.shot.videoJobId='manually-selected';writeFileSync(other.args[3],'HD');other.child.stdout.emit('data',Buffer.from('{"metadata":{"width":1152,"height":720}}\n'));other.child.emit('close',0);assert.equal(hd.status,'success');assert.equal(other.shot.videoJobId,'manually-selected');
});
