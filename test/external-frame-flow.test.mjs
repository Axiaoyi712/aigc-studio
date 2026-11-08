import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {existsSync} from 'node:fs';
import {mkdtemp,mkdir,writeFile,copyFile,rename,unlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {createStudio} from '../server.mjs';
import {localMedia} from '../media.mjs';
import {frameMatches,videoMatches} from '../production.mjs';

const appRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const pythonPath=process.env.AIGC_TEST_PYTHON||'E:/ComfyUI-Intel/ComfyUI-NVIDIA/ComfyUI_windows_portable/python_embeded/python.exe';
const options={skip:existsSync(pythonPath)?false:'Set AIGC_TEST_PYTHON to a Python with Pillow; tests only decode fixture images.'};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

// Real, tiny PNG fixtures with different pixels; no image generation engine is involved.
function png(red,width=64,height=96){
 function chunk(type,data){const name=Buffer.from(type),body=Buffer.concat([name,data]);let crc=0xffffffff;for(const byte of body){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}const size=Buffer.alloc(4),sum=Buffer.alloc(4);size.writeUInt32BE(data.length);sum.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([size,body,sum]);}
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=2;
 const pixels=Buffer.alloc(height*(width*3+1));for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=y*(width*3+1)+1+x*3;pixels[i]=red;pixels[i+1]=80;pixels[i+2]=150;}
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
async function listen(server){await new Promise((ok,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',fail);ok();});});}
async function harness(t){
 const temp=await mkdtemp(resolve(tmpdir(),'aigc-external-flow-')),comfyRoot=resolve(temp,'comfy');
 await mkdir(resolve(temp,'workflows'),{recursive:true});await mkdir(resolve(comfyRoot,'output'),{recursive:true});await mkdir(resolve(comfyRoot,'input/aigc-studio'),{recursive:true});
 await copyFile(resolve(appRoot,'image-info.py'),resolve(temp,'image-info.py'));
 const graph={nodes:[{id:1,type:'LoadImage',widgets_values:['fixture.png']},{id:2,type:'SaveImage',widgets_values:['fixture'],inputs:[{name:'images',link:1}]}],links:[[1,1,0,2,0,'IMAGE']]};
 for(const name of ['flux-edit','h3-fast'])await writeFile(resolve(temp,'workflows',name+'.json'),JSON.stringify(graph));
 const engine={running:[],history:{},submitted:[]};
 const upstream=http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks);let value;
  if(req.url==='/object_info')value={LoadImage:{input:{required:{image:[['fixture.png']]}},output:['IMAGE']},SaveImage:{input:{required:{images:['IMAGE'],filename_prefix:['STRING']}},output:[]}};
  else if(req.url==='/queue')value={queue_running:engine.running,queue_pending:[]};
  else if(req.url.startsWith('/history/')){const id=req.url.split('/').at(-1);value=engine.history[id]?{[id]:engine.history[id]}:{};}
  else if(req.url==='/prompt'){const input=JSON.parse(body);engine.submitted.push(input);engine.running=[[0,input.prompt_id]];value={prompt_id:input.prompt_id};}
  else if(req.url==='/system_stats')value={devices:[]};
  else{res.writeHead(404);return res.end('{}');}
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));
 });await listen(upstream);
 const config={name:'External frame integration test',projectStorage:true,comfyRoot,comfyUrl:`http://127.0.0.1:${upstream.address().port}`,pythonPath};
 const app=createStudio(config,{appRoot:temp,websocket:false});await listen(app.server);const url=`http://127.0.0.1:${app.server.address().port}`;
 t.after(async()=>{app.server.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise(ok=>app.server.close(ok)),new Promise(ok=>upstream.close(ok))]);await rm(temp,{recursive:true,force:true});});
 const post=(path,value)=>fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
 async function json(path,value,status=200){const response=await post(path,value);assert.equal(response.status,status,await response.clone().text());return response.json();}
 async function project(name='External frames'){const p=await json('/api/projects',{name},201);p.production={style:'自然电影质感'};p.shots=[{id:randomUUID(),title:'镜头 1',imagePrompt:'',videoPrompt:'人物缓慢转头。',referenceIds:[],seed:''}];await json('/api/projects/'+p.id,p);return app.state.projects.find(item=>item.id===p.id);}
 async function source(name='external.png',bytes=png(200)){const path=resolve(temp,name);await writeFile(path,bytes);return path;}
 async function importFrame(p,path){return (await json(`/api/projects/${p.id}/frames/import`,{shotId:p.shots[0].id,localPath:path})).frame;}
 async function confirm(p,jobId){return json(`/api/projects/${p.id}/select`,{shotId:p.shots[0].id,kind:'image',jobId});}
 async function queueVideo(p){await json('/api/batch-queue/pause',{paused:true});return json(`/api/projects/${p.id}/batch`,{requestId:randomUUID(),kind:'video',shotIds:[p.shots[0].id]},201);}
 async function dispatch(){await json('/api/batch-queue/pause',{paused:false});await app.tick();}
 async function stabilize(){const now=Date.now()+5000;app.syncFolders(now);app.syncFolders(now+3001);}
 return {app,config,temp,url,engine,post,json,project,source,importFrame,confirm,queueVideo,dispatch,stabilize};
}

test('external frame needs explicit confirmation and then animates without an image description',options,async t=>{
 const h=await harness(t),p=await h.project(),source=await h.source(),frame=await h.importFrame(p,source);const shot=p.shots[0];
 assert.equal(frame.source,'external');assert.equal(shot.confirmedFrameJobId,null);assert.ok(existsSync(source),'default import preserves the external original');assert.equal(frame.externalFrame.width,64);assert.equal(frame.externalFrame.height,96);
 let response=await h.post(`/api/projects/${p.id}/batch`,{requestId:randomUUID(),kind:'video',shotIds:[shot.id]});assert.equal(response.status,400);
 await h.confirm(p,frame.id);assert.equal(shot.frameApproval.jobId,frame.id);assert.equal(shot.frameApproval.sha256,digest(png(200)));assert.equal(frameMatches(p,shot,h.app.state.jobs.find(j=>j.id===frame.id),[]),true);
 const [item]=await h.queueVideo(p);await h.dispatch();assert.equal(h.engine.submitted.length,1);const job=h.app.state.jobs.find(j=>j.id===item.id);assert.equal(job.frameJobId,frame.id);assert.equal(job.externalFrameHash,shot.frameApproval.sha256);
});

test('external frame approval survives prompt and role edits while an old video becomes stale',options,async t=>{
 const h=await harness(t),p=await h.project(),roleFolder=resolve(h.config.comfyRoot,'output','AIGC项目',p.storageFolder,'角色','主角');await mkdir(roleFolder,{recursive:true});await writeFile(resolve(roleFolder,'正面.png'),png(60));await h.stabilize();assert.equal(p.characters.length,1);
 const frame=await h.importFrame(p,await h.source());await h.confirm(p,frame.id);
 const [item]=await h.queueVideo(p);await h.dispatch();const video=h.app.state.jobs.find(j=>j.id===item.id),output=resolve(h.config.comfyRoot,'output','clip.mp4');await writeFile(output,'fixture-video');
 h.engine.running=[];h.engine.history[item.id]={status:{status_str:'success',completed:true},outputs:{2:{gifs:[{filename:'clip.mp4',subfolder:'',type:'output'}]}}};await h.app.tick();assert.equal(videoMatches(p,p.shots[0],video,h.app.state.assets),true);
 const edited=structuredClone(p);edited.shots[0].generalPrompt='餐厅里人物转头后站起来。';edited.characters[0].description='穿黑色外套';edited.shots[0].characterIds=[edited.characters[0].id];await h.json('/api/projects/'+p.id,edited);
 const current=h.app.state.projects.find(x=>x.id===p.id),shot=current.shots[0];assert.equal(shot.confirmedFrameJobId,frame.id);assert.equal(frameMatches(current,shot,h.app.state.jobs.find(j=>j.id===frame.id),h.app.state.assets),true);assert.equal(videoMatches(current,shot,video,h.app.state.assets),false);
 assert.equal((await h.queueVideo(current))[0].frameJobId,frame.id);
});

test('selecting an older imported version submits that version instead of the newest frame',options,async t=>{
 const h=await harness(t),p=await h.project(),old=await h.importFrame(p,await h.source('old.png',png(100))),latest=await h.importFrame(p,await h.source('latest.png',png(210)));assert.notEqual(old.id,latest.id);
 const staleEditor=structuredClone(p);await h.confirm(p,old.id);staleEditor.shots[0].videoPrompt='缓慢眨眼。';await h.json('/api/projects/'+p.id,staleEditor);
 const current=h.app.state.projects.find(x=>x.id===p.id),[item]=await h.queueVideo(current);await h.dispatch();
 assert.equal(item.frameJobId,old.id);assert.equal(h.app.state.jobs.find(j=>j.id===item.id).externalFrameHash,digest(png(100)));
 const output=h.app.state.jobs.find(j=>j.id===old.id).outputs[0];assert.equal(h.engine.submitted[0].prompt['1'].inputs.image,[output.subfolder,output.filename].filter(Boolean).join('/')+' [output]');
});

test('folder candidates follow addition, renaming, content replacement and deletion',options,async t=>{
 const h=await harness(t),p=await h.project(),shot=p.shots[0],folder=resolve(h.config.comfyRoot,'output','AIGC项目',p.storageFolder,shot.storageFolder,'首帧');
 const first=resolve(folder,'自制首帧.png');await writeFile(first,png(90));await h.stabilize();
 const frame=h.app.state.jobs.find(j=>j.source==='external'&&j.shotId===shot.id);assert.ok(frame,'new file is a shot candidate');assert.ok(shot.imageHistory.includes(frame.id));assert.equal(shot.confirmedFrameJobId,null);
 const renamed=resolve(folder,'修订名称.png');await rename(localMedia(h.config,frame.outputs[0]),renamed);await h.stabilize();assert.equal(localMedia(h.config,frame.outputs[0]),renamed);assert.equal(h.app.state.jobs.filter(j=>!j.deletedAt&&j.source==='external').length,1);
 await h.confirm(p,frame.id);const hash=shot.frameApproval.sha256;await writeFile(renamed,png(160));await h.stabilize();assert.equal(shot.confirmedFrameJobId,null);assert.equal(shot.frameApproval??null,null);assert.notEqual(frame.externalFrame.sha256,hash);assert.equal(frame.externalFrame.sha256,digest(png(160)));
 await h.confirm(p,frame.id);await unlink(renamed);await h.stabilize();assert.equal(shot.confirmedFrameJobId,null);assert.equal(shot.frameApproval??null,null);assert.ok(!shot.imageHistory.includes(frame.id));
});

test('replaced bytes are rejected at dispatch even before the folder scanner notices them',options,async t=>{
 const h=await harness(t),p=await h.project(),frame=await h.importFrame(p,await h.source());await h.confirm(p,frame.id);const [item]=await h.queueVideo(p),job=h.app.state.jobs.find(j=>j.id===frame.id);await writeFile(localMedia(h.config,job.outputs[0]),png(110));
 await h.dispatch();assert.equal(h.engine.submitted.length,0);assert.equal(h.app.state.batchQueue.find(q=>q.id===item.id).status,'failed');
});

test('saving a project before scanning a replaced external frame still revokes approval and refreshes its identity',options,async t=>{
 const h=await harness(t),p=await h.project(),frame=await h.importFrame(p,await h.source());await h.confirm(p,frame.id);
 const job=h.app.state.jobs.find(j=>j.id===frame.id),originalHash=p.shots[0].frameApproval.sha256,replacement=png(135);await writeFile(localMedia(h.config,job.outputs[0]),replacement);
 await h.json('/api/projects/'+p.id,structuredClone(p));assert.equal(job.outputs[0].sha256,digest(replacement));assert.equal(job.externalFrame.sha256,originalHash,'saving updates storage metadata before the folder scanner runs');
 await h.stabilize();const shot=p.shots[0];assert.equal(shot.confirmedFrameJobId,null);assert.equal(shot.frameApproval??null,null);assert.equal(job.externalFrame.sha256,digest(replacement));
 await h.confirm(p,frame.id);assert.equal(shot.confirmedFrameJobId,frame.id);assert.equal(shot.frameApproval.sha256,digest(replacement));assert.equal(frameMatches(p,shot,job,h.app.state.assets),true);
});

test('deleting either project preserves a shared external frame in the surviving project',options,async t=>{
 for(const removeFirst of [true,false]){
  const h=await harness(t),source=await h.source(),p=await h.project('First'),q=await h.project('Second'),a=await h.importFrame(p,source),b=await h.importFrame(q,source);await h.confirm(p,a.id);await h.confirm(q,b.id);
  const victim=removeFirst?p:q,survivor=removeFirst?q:p,frame=removeFirst?b:a,file=()=>localMedia(h.config,h.app.state.jobs.find(j=>j.id===frame.id).outputs[0]);assert.equal(localMedia(h.config,h.app.state.jobs.find(j=>j.id===a.id).outputs[0]),localMedia(h.config,h.app.state.jobs.find(j=>j.id===b.id).outputs[0]),'identical pixels have one managed original');
  const response=await fetch(h.url+'/api/projects/'+victim.id,{method:'DELETE',headers:{'Content-Type':'application/json'}});assert.equal(response.status,200,await response.clone().text());assert.ok(existsSync(file()));assert.equal(survivor.shots[0].confirmedFrameJobId,frame.id);assert.equal(frameMatches(survivor,survivor.shots[0],h.app.state.jobs.find(j=>j.id===frame.id),[]),true);assert.ok(existsSync(source));
  assert.equal((await h.queueVideo(survivor))[0].frameJobId,frame.id);
 }
});

test('explicit permanent deletion clears every alias, approval and project reference',options,async t=>{
 const h=await harness(t),source=await h.source(),p=await h.project('First'),q=await h.project('Second'),a=await h.importFrame(p,source),b=await h.importFrame(q,source);await h.confirm(p,a.id);await h.confirm(q,b.id);
 const original=localMedia(h.config,h.app.state.jobs.find(j=>j.id===a.id).outputs[0]);await h.json('/api/jobs/delete',{jobIds:[a.id]});assert.equal(existsSync(original),false);assert.ok(existsSync(source),'external unmanaged source remains outside permanent deletion scope');
 for(const project of [p,q]){const shot=project.shots[0];assert.equal(shot.imageJobId,null);assert.equal(shot.confirmedFrameJobId,null);assert.equal(shot.frameApproval??null,null);assert.deepEqual(shot.imageHistory,[]);}
 for(const id of [a.id,b.id]){const frame=h.app.state.jobs.find(j=>j.id===id);assert.ok(frame.deletedAt);assert.deepEqual(frame.outputs,[]);}
});
