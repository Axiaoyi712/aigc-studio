import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {resolve,dirname,relative,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {createExternalFrames,inspectImage} from '../external-frames.mjs';
import {createStorage} from '../storage.mjs';
import {localMedia,primaryOutput} from '../media.mjs';

const appRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const pythonPath=process.env.AIGC_TEST_PYTHON||'E:/ComfyUI-Intel/ComfyUI-NVIDIA/ComfyUI_windows_portable/python_embeded/python.exe';
const options={skip:existsSync(pythonPath)?false:'Set AIGC_TEST_PYTHON to a Python with Pillow.'};
function png(width=32,height=48){
 function chunk(type,data){const name=Buffer.from(type),body=Buffer.concat([name,data]);let crc=0xffffffff;for(const byte of body){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}const length=Buffer.alloc(4),sum=Buffer.alloc(4);length.writeUInt32BE(data.length);sum.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([length,body,sum]);}
 const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.alloc(height*(width*3+1)))),chunk('IEND',Buffer.alloc(0))]);
}
function fixture(t){
 const root=mkdtempSync(resolve(tmpdir(),'external-frames-module-')),config={comfyRoot:resolve(root,'comfy'),projectStorage:true,pythonPath},shot={id:randomUUID(),title:'镜头 1',imagePrompt:'',videoPrompt:'人物转身',referenceIds:[],videoHistory:['old-video']},project={id:randomUUID(),name:'Project',shots:[shot],characters:[],catalog:[]};
 for(const dir of ['output','input/aigc-studio','temp'])mkdirSync(resolve(config.comfyRoot,dir),{recursive:true});
 const state={projects:[project],jobs:[],assets:[],uploads:{},batchQueue:[],exports:[]},storage=createStorage(config,state,resolve(root,'data'));
 const send=(res,status,body)=>Object.assign(res,{status,body});let busy=false,saves=0;
 const frames=createExternalFrames({state,config,storage,save:()=>{saves++;storage.sync();},send,readBody:async req=>Buffer.from(JSON.stringify(req.body)),appRoot,isBusy:()=>busy});
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const request=async(path,body,method='POST')=>{const res={};await frames.handle({method,body},res,new URL(path,'http://localhost'));return res;};
 const source=(name='external.png',bytes=png())=>{const path=resolve(root,name);writeFileSync(path,bytes);return path;};
 return {root,config,state,storage,frames,shot,project,request,source,setBusy:v=>busy=v,saves:()=>saves};
}

test('real decoding rejects corrupt content, disguised format and oversized images',options,t=>{
 const h=fixture(t),file=h.source(),info=inspectImage(h.config,appRoot,file);assert.equal(info.width,32);assert.equal(info.height,48);assert.equal(info.format,'PNG');assert.match(info.sha256,/^[a-f0-9]{64}$/);
 assert.throws(()=>inspectImage(h.config,appRoot,h.source('broken.png',Buffer.from('not a PNG'))));
 assert.throws(()=>inspectImage(h.config,appRoot,h.source('disguised.jpg',png())));
 assert.throws(()=>inspectImage(h.config,appRoot,h.source('large.png',Buffer.alloc(20*1024*1024+1))),/20MB/);
 const header=png();header.writeUInt32BE(10000,16);header.writeUInt32BE(10000,20);assert.throws(()=>inspectImage(h.config,appRoot,h.source('huge.png',header)));
});

test('external import copies by default, keeps video history and requires explicit approval',options,async t=>{
 const h=fixture(t),source=h.source(),result=await h.request(`/api/projects/${h.project.id}/frames/import`,{shotId:h.shot.id,localPath:source,name:'正式首帧.png'});
 assert.equal(result.status,200);const job=result.body.frame;assert.equal(job.externalFrame.name,'正式首帧.png');assert.equal(job.source,'external');assert.equal(job.template,'external-frame');assert.equal(job.seed,undefined);assert.equal(job.workflowSnapshot,undefined);assert.equal(h.shot.confirmedFrameJobId,null);assert.equal(h.shot.frameApproval,null);assert.deepEqual(h.shot.videoHistory,['old-video']);assert.ok(existsSync(source));
 assert.equal(job.outputs[0].url,`/api/media/${job.id}/0`);assert.ok(localMedia(h.config,primaryOutput(job)).startsWith(h.storage.root+sep));
 h.frames.approve(h.project,h.shot,h.state.jobs.find(j=>j.id===job.id));assert.equal(h.shot.confirmedFrameJobId,job.id);assert.equal(h.shot.frameApproval.sha256,job.externalFrame.sha256);
});

test('path inspection is read-only, works while generating and leaves no picker lock',options,async t=>{
 const h=fixture(t),path=h.source(),before=structuredClone(h.state);h.setBusy(true);
 const result=await h.request('/api/frames/inspect',{localPath:path});
 assert.equal(result.status,200);assert.equal(result.body.path,path);assert.equal(result.body.name,'external.png');assert.equal(result.body.width,32);assert.equal(result.body.height,48);
 assert.deepEqual(Buffer.from(result.body.dataUrl.split(',')[1],'base64'),readFileSync(path));assert.deepEqual(h.state,before);assert.equal(h.saves(),0);
 assert.equal(existsSync(h.storage.projectFolder(h.project)),false);
 assert.equal(await h.frames.handle({method:'POST'}, {},new URL('/api/frames/pick','http://localhost')),false);
 h.setBusy(false);assert.equal((await h.request(`/api/projects/${h.project.id}/frames/import`,{shotId:h.shot.id,localPath:path})).status,200);assert.ok(existsSync(path));
});

test('path inspection rejects missing, relative, corrupt and oversized sources without mutation',options,async t=>{
 const h=fixture(t),before=structuredClone(h.state);
 for(const localPath of [undefined,42,'relative.png',resolve(h.root,'missing.png'),h.source('bad.txt'),h.source('bad.png',Buffer.from('broken')),h.source('too-big.png',Buffer.alloc(20*1024*1024+1))]){
  await assert.rejects(h.request('/api/frames/inspect',{localPath}),e=>[400,404].includes(e.status));
 }
 assert.deepEqual(h.state,before);assert.equal(h.saves(),0);assert.ok(existsSync(resolve(h.root,'bad.png')));
});

test('explicit move removes the source only after successful validated registration',options,async t=>{
 const h=fixture(t),source=h.source();const {body}=await h.request(`/api/projects/${h.project.id}/frames/import`,{shotId:h.shot.id,localPath:source,mode:'move'});
 assert.equal(existsSync(source),false);const stored=localMedia(h.config,primaryOutput(body.frame));assert.ok(existsSync(stored));assert.deepEqual(readFileSync(stored),png());assert.equal(h.saves(),1);
 const broken=h.source('broken.png',Buffer.from('broken'));await assert.rejects(h.request(`/api/projects/${h.project.id}/frames/import`,{shotId:h.shot.id,localPath:broken,mode:'move'}));assert.ok(existsSync(broken));
});

test('managed generated images become aliases without changing the original job identity or copying bytes',options,async t=>{
 const h=fixture(t),folder=resolve(h.storage.shotFolder(h.project,h.shot),'首帧');mkdirSync(folder,{recursive:true});const path=resolve(folder,'generated.png');writeFileSync(path,png());
 const file={index:0,kind:'image',type:'output',subfolder:relative(resolve(h.config.comfyRoot,'output'),folder).split(sep).join('/'),filename:'generated.png'},generated={id:randomUUID(),section:'image',status:'success',template:'flux-edit',outputs:[file]};h.state.jobs.push(generated);
 const route=`/api/projects/${h.project.id}/frames/import`,first=(await h.request(route,{shotId:h.shot.id,jobId:generated.id})).body.frame,second=(await h.request(route,{shotId:h.shot.id,jobId:generated.id})).body.frame;
 assert.notEqual(first.id,generated.id);assert.equal(first.id,second.id);assert.equal(first.externalFrame.sourceJobId,generated.id);assert.equal(generated.template,'flux-edit');assert.equal(generated.source,undefined);assert.equal(localMedia(h.config,file),localMedia(h.config,primaryOutput(first)));assert.equal(h.shot.imageHistory.length,1);
});

test('approval rechecks decoded bytes and rejects images changed since import',options,async t=>{
 const h=fixture(t),job=(await h.request(`/api/projects/${h.project.id}/frames/import`,{shotId:h.shot.id,localPath:h.source()})).body.frame;
 const path=localMedia(h.config,primaryOutput(job));writeFileSync(path,png(64,64));assert.throws(()=>h.frames.approve(h.project,h.shot,h.state.jobs.find(j=>j.id===job.id)),/已更改/);assert.equal(h.shot.confirmedFrameJobId,null);
});

test('source chooser limits assets to the current project and excludes deleted, failed and video jobs',options,async t=>{
 const h=fixture(t),path=h.source();await h.request(`/api/projects/${h.project.id}/frames/import`,{shotId:h.shot.id,localPath:path});const good=h.state.jobs[0];
 h.state.jobs.push({...structuredClone(good),id:'failed',status:'failed'},{...structuredClone(good),id:'deleted',deletedAt:new Date().toISOString()},{...structuredClone(good),id:'video',outputs:[{...primaryOutput(good),kind:'video'}]});
 h.state.uploads.u={file:{...primaryOutput(good)}};h.state.assets.push({id:'own',name:'Own',uploadId:'u'},{id:'other',name:'Other',uploadId:'u'});h.project.catalog=[{id:'g',assetIds:['own']}];
 const result=await h.request(`/api/projects/${h.project.id}/frames/sources`,undefined,'GET');assert.equal(result.status,200);assert.ok(result.body.some(s=>s.type==='asset'&&s.id==='own'));assert.ok(!result.body.some(s=>['failed','deleted','video','other'].includes(s.id)));
});

test('busy guard, multiple-source requests and traversal fail without importing or removing anything',options,async t=>{
 const h=fixture(t),path=h.source(),route=`/api/projects/${h.project.id}/frames/import`;h.setBusy(true);await assert.rejects(h.request(route,{shotId:h.shot.id,localPath:path}),e=>e.status===409);h.setBusy(false);
 await assert.rejects(h.request(route,{shotId:h.shot.id,localPath:path,jobId:'wrong'}),/一个/);
 await assert.rejects(h.request(route,{shotId:h.shot.id,relativePath:'../../external.png'}));assert.equal(h.state.jobs.length,0);assert.ok(existsSync(path));
});
