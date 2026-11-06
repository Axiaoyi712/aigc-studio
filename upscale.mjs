import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {existsSync,mkdirSync,unlinkSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {primaryOutput,requireMedia} from './media.mjs';
const active=new Set(['submitting','queued','running','recovering']);
const fault=(message,status=400)=>Object.assign(Error(message),{status});

export function createUpscaler({state,save,config,appRoot,send,readBody,json,post,publicJob,isBusy,release,spawnProcess=spawn}){
 const model=resolve(config.comfyRoot,'models/upscale_models/RealESRGAN_x2plus.pth');
 let child=null,current=null,starting=false;
 for(const j of state.jobs)if(j.template==='video-upscale'&&active.has(j.status)){j.status='failed';j.error='创作台上次退出时精修未完成，原视频保留，可重新精修。';save();}
 function start(job,input,output){
  const python=config.pythonPath||resolve(config.comfyRoot,'../python_embeded/python.exe');
  child=spawnProcess(python,['-s',resolve(appRoot,'upscale-video.py'),input,output,config.comfyRoot,model],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PYTHONIOENCODING:'utf-8'}});current=job;
  let buffer='',errors='',metadata,spawnError;
  child.stdout.on('data',bytes=>{buffer+=bytes.toString();const lines=buffer.split('\n');buffer=lines.pop();for(const line of lines){let event;try{event=JSON.parse(line);}catch{continue;}if(event.progress){job.progress=event.progress;save();}if(event.metadata)metadata=event.metadata;}});
  child.stderr.on('data',bytes=>errors=(errors+bytes.toString()).slice(-4000));
  child.on('error',error=>{spawnError=error.message;});
  child.on('close',code=>{
   child=null;current=null;job.finishedAt=new Date().toISOString();
   if(job.status!=='cancelled'){
    if(code===0&&metadata&&existsSync(output)){
     job.status='success';job.outputs=[{index:0,type:'output',kind:'video',filename:output.split(/[\\/]/).pop(),subfolder:'aigc-studio',metadata}];
     const shot=state.projects.find(p=>p.id===job.projectId)?.shots.find(s=>s.id===job.shotId);if(shot&&!shot.videoHistory.includes(job.id))shot.videoHistory.push(job.id);
    }else{job.status='failed';job.error=spawnError||errors||'高清精修失败，原视频未改动。';}
   }
   const partial=output.replace(/\.mp4$/,'.partial.mp4');if(existsSync(partial))unlinkSync(partial);
   save();
  });
 }
 async function handle(req,res,url){
  const match=url.pathname.match(/^\/api\/jobs\/([a-f0-9-]+)\/(upscale|comparison|cancel)$/);
  if(!match)return false;
  const source=state.jobs.find(j=>j.id===match[1]);
  if(match[2]==='cancel'){
   if(source?.template!=='video-upscale')return false;
   if(req.method!=='POST')throw fault('请求方法无效。');
   if(source===current&&child){source.status='cancelled';source.error='已停止精修，原视频保留。';child.kill();save();}send(res,200,publicJob(source));return true;
  }
  if(!source)throw fault('视频任务不存在。',404);
  if(match[2]==='comparison'){
   if(req.method!=='GET')throw fault('请求方法无效。');
   const original=state.jobs.find(j=>j.id===source.sourceVideoJobId);
   if(!source.enhancement||source.status!=='success'||!original)throw fault('还没有可对比的高清版本。');
   requireMedia(config,primaryOutput(original));requireMedia(config,primaryOutput(source));send(res,200,{source:publicJob(original),enhanced:publicJob(source)});return true;
  }
  if(req.method!=='POST')throw fault('请求方法无效。');
  await readBody(req);
  if(source.status!=='success'||primaryOutput(source)?.kind!=='video')throw fault('请选择已完成的视频。');
  if(source.enhancement)throw fault('该视频已是精修版本，请从原片重新精修。');
  const existing=state.jobs.find(j=>j.sourceVideoJobId===source.id&&j.enhancement&&(active.has(j.status)||j.status==='success'));
  if(existing){send(res,200,publicJob(existing));return true;}
  if(starting||child||isBusy())throw fault('请等待生成、精修或拼接完成，并清空待执行队列后再试。',409);
  if(!existsSync(model))throw fault('缺少 RealESRGAN_x2plus.pth 超分模型，请按部署说明安装。');
   requireMedia(config,primaryOutput(source));
  starting=true;
  try{
   const queue=await json('/queue');if(queue.queue_running.length||queue.queue_pending.length)throw fault('ComfyUI 正在处理其他任务，请稍后精修。',409);
   await release();await post('/free',{unload_models:true,free_memory:true});
   const id=randomUUID(),job={...structuredClone(source),id,template:'video-upscale',title:source.title+' · 高清精修1080p',sourceVideoJobId:source.id,enhancement:{model:'RealESRGAN_x2plus',target:'1080p'},createdAt:new Date().toISOString(),status:'running',outputs:[],progress:{value:0,max:0}};
   for(const key of ['deletedAt','finishedAt','error','node'])delete job[key];
   job.workflowSnapshot={version:'0.6.0',source:'video-upscale',capturedAt:job.createdAt,models:['RealESRGAN_x2plus.pth'],sourceVideoJobId:source.id};
   const folder=resolve(config.comfyRoot,'output/aigc-studio');mkdirSync(folder,{recursive:true});const output=resolve(folder,id+'.mp4');
   state.jobs.unshift(job);save();start(job,requireMedia(config,primaryOutput(source)),output);send(res,202,publicJob(job));return true;
  }finally{starting=false;}
 }
 return {handle,busy:()=>starting||!!child,close:()=>child?.kill()};
}
