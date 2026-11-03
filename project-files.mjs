import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, statSync, createReadStream, unlinkSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { spawn } from 'node:child_process';
import { localMedia, requireMedia } from './media.mjs';
import { validateCharacters } from './characters.mjs';
import { normalizeProduction, normalizeDirector } from './public/director-options.js';
import { shotPlan } from './production.mjs';
const fault = message => Object.assign(Error(message), {status:400});

export function pythonJSON(config, appRoot, script, args) {
  return new Promise((ok,reject)=>{
    const python=config.pythonPath||resolve(config.comfyRoot,'../python_embeded/python.exe');
    const child=spawn(python,['-s',resolve(appRoot,script),...args],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output='',errors='';
    child.stdout.on('data',b=>output+=b.toString());child.stderr.on('data',b=>errors=(errors+b.toString()).slice(-3000));
    child.on('error',reject);child.on('close',code=>{if(code!==0)return reject(fault(errors||'本地文件处理失败。'));try{ok(JSON.parse(output.trim()));}catch{reject(fault('文件处理结果无效。'));}});
  });
}
export function streamFile(req,res,path,type,name) {
  const size=statSync(path).size;let start=0,end=size-1,status=200;
  if(req.headers.range){const match=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range);if(!match)throw fault('读取范围无效。');start=Number(match[1]);end=match[2]?Math.min(Number(match[2]),end):end;if(start>end)throw fault('读取范围超出文件。');status=206;}
  const headers={'Content-Type':type,'Content-Length':end-start+1,'Accept-Ranges':'bytes','Cache-Control':'no-store'};
  if(status===206)headers['Content-Range']=`bytes ${start}-${end}/${size}`;
  if(name)headers['Content-Disposition']=`attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
  res.writeHead(status,headers);const stream=createReadStream(path,{start,end});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
}
export function createProjectFiles({state,save,config,appRoot,dataRoot,readBody,send}) {
  state.audioAssets??=[];state.archives??=[];
  const folder=resolve(dataRoot,'archives');mkdirSync(folder,{recursive:true});mkdirSync(resolve(dataRoot,'audio'),{recursive:true});
  const projectById=id=>state.projects.find(p=>p.id===id);
  function archiveData(project) {
    const jobs=structuredClone(state.jobs.filter(j=>j.projectId===project.id));
    const assetIds=new Set([...(project.production?.referenceIds||[]),...(project.characters||[]).flatMap(c=>c.referenceIds),...project.shots.flatMap(s=>s.referenceIds)]);
    const assets=structuredClone(state.assets.filter(a=>assetIds.has(a.id)));
    const uploadIds=new Set([...assets.map(a=>a.uploadId),...jobs.flatMap(j=>j.images||[])]);
    const uploads=Object.fromEntries([...uploadIds].map(id=>[id,state.uploads[id]]));
    const audioAssets=structuredClone(state.audioAssets.filter(a=>a.id===project.production?.backgroundAudioId));
    const exports=structuredClone(state.exports.filter(e=>e.projectId===project.id));
    const files=[];
    const add=(kind,id,path,extra={})=>{if(!path||!existsSync(path))throw fault('归档所需素材缺失，请先修复引用。');files.push({kind,id,...extra,path,archive:`media/${files.length}${extname(path).toLowerCase()}`});};
    for(const [id,u] of Object.entries(uploads)){if(!u)throw fault('上传记录缺失。');const slash=u.name.lastIndexOf('/');add('upload',id,requireMedia(config,{type:'input',filename:u.name.slice(slash+1),subfolder:u.name.slice(0,slash)}));}
    for(const j of jobs){j.outputs=j.outputs.filter(o=>o.type==='output'&&existsSync(localMedia(config,o)||'')).map((o,index)=>({...o,index}));if(j.status==='success'&&!j.outputs.length)throw fault('成功任务的正式成品缺失，不能生成不完整的归档。');for(const o of j.outputs)add('job',j.id,localMedia(config,o),{index:o.index});}
    for(const a of audioAssets)add('audio',a.id,resolve(dataRoot,'audio',a.filename));
    for(const e of exports)if(e.status==='success')add('export',e.id,e.storagePath||resolve(dataRoot,'exports',e.id+'.mp4'));
    return {schemaVersion:1,createdAt:new Date().toISOString(),project:structuredClone(project),jobs,assets,uploads,audioAssets,exports,files};
  }
  async function restore(zip) {
    const importId=randomUUID(),destination=resolve(folder,importId);
    await pythonJSON(config,appRoot,'archive-project.py',['unpack',zip,destination]);
    const data=JSON.parse(readFileSync(resolve(destination,'project.json'),'utf8'));
    if(!Array.isArray(data.jobs)||data.jobs.length>5000||!Array.isArray(data.assets)||!Array.isArray(data.project?.shots)||data.project.shots.length>50||!data.project.name)throw fault('项目归档结构无效。');
    const ids=new Map();const addId=id=>{if(typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id))throw fault('归档编号无效。');if(!ids.has(id))ids.set(id,randomUUID());};
    for(const item of [data.project,...data.project.shots,...(data.project.characters||[]),...data.jobs,...data.assets,...(data.audioAssets||[]),...(data.exports||[])])addId(item.id);
    for(const id of Object.keys(data.uploads||{}))addId(id);
    const map=id=>ids.get(id)||id;
    const idArrays=new Set(['characterIds','referenceIds','jobIds','imageHistory','videoHistory','images']);
    const relink=(value,key='')=>{
      if(Array.isArray(value))return value.map(v=>idArrays.has(key)&&typeof v==='string'?map(v):relink(v));
      if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[key==='referenceNotes'?map(k):k,relink(v,k)]));
      return (key==='id'||key.endsWith('Id'))&&typeof value==='string'?map(value):value;
    };
    const project=relink(data.project),jobs=relink(data.jobs),assets=relink(data.assets),audioAssets=relink(data.audioAssets||[]),exports=relink(data.exports||[]);
    for(const e of exports)delete e.storagePath;for(const a of assets)delete a.projectFiles;delete project.storageFolder;for(const s of project.shots)delete s.storageFolder;
    
    const uploads=Object.fromEntries(Object.entries(data.uploads||{}).map(([id,u])=>[map(id),structuredClone(u)]));
    if(project.production)project.production=normalizeProduction(project.production,assets);
    project.characters=validateCharacters(project.characters||[],assets);
    for(const shot of project.shots)if(shot.director)shot.director=normalizeDirector(shot.director);
    for(const file of data.files){
      const source=resolve(destination,file.archive);let target;
      const id=map(file.id);const extension=extname(file.archive);
      if(!['.png','.jpg','.jpeg','.webp','.mp4','.webm','.mkv','.wav','.mp3','.flac','.m4a','.ogg'].includes(extension))throw fault('归档中有不支持的素材。');
      if(file.kind==='upload'&&uploads[id]){uploads[id].name=`aigc-studio/restored/${importId}/${id}${extension}`;target=resolve(config.comfyRoot,'input',uploads[id].name);}
      else if(file.kind==='job'){
        const output=jobs.find(j=>j.id===id)?.outputs?.[file.index];if(!output)throw fault('归档成品引用无效。');
        Object.assign(output,{type:'output',subfolder:`aigc-studio/restored/${importId}`,filename:`${id}-${file.index}${extension}`});target=localMedia(config,output);
      }else if(file.kind==='audio'){const a=audioAssets.find(a=>a.id===id);if(!a)throw fault('声音引用无效。');a.filename=id+extension;target=resolve(dataRoot,'audio',a.filename);}
      else if(file.kind==='export'&&exports.some(e=>e.id===id))target=resolve(dataRoot,'exports',id+'.mp4');
      else throw fault('归档文件映射无效。');
      mkdirSync(resolve(target,'..'),{recursive:true});copyFileSync(source,target);
    }
    for(const [index,oldShot] of data.project.shots.entries()){
      const shot=project.shots[index];const before=shotPlan(data.project,oldShot,data.assets),after=shotPlan(project,shot,assets);
      for(const old of data.jobs.filter(j=>j.shotId===oldShot.id)){
        const job=jobs.find(j=>j.id===map(old.id));
        if(old.characterSignature===before.characterSignature)job.characterSignature=after.characterSignature;
        if(old.frameSignature===before.frameSignature)job.frameSignature=after.frameSignature;
        if(old.videoSignature===before.videoSignature)job.videoSignature=after.videoSignature;
      }
    }
    for(const job of jobs)if(['queued','running','recovering','submitting'].includes(job.status)){job.status='failed';job.error='归档时任务尚未完成，请重新生成。';}
    project.name=String(project.name).slice(0,70)+'（恢复副本）';project.restoredAt=new Date().toISOString();
    state.projects.push(project);state.jobs.push(...jobs);state.assets.push(...assets);Object.assign(state.uploads,uploads);state.audioAssets.push(...audioAssets);state.exports.push(...exports);save();
    return project;
  }
  async function handle(req,res,url){
    if(url.pathname==='/api/audio'){
      if(req.method==='GET'){send(res,200,state.audioAssets);return true;}
      if(req.method!=='POST')throw fault('不支持的声音操作。');
      const type=req.headers['content-type']?.split(';')[0];const extension={'audio/wav':'.wav','audio/x-wav':'.wav','audio/mpeg':'.mp3','audio/mp3':'.mp3','audio/mp4':'.m4a','audio/ogg':'.ogg','audio/flac':'.flac','audio/x-flac':'.flac'}[type];
      if(!extension)throw fault('请上传 WAV、MP3、M4A、OGG 或 FLAC 声音。');
      const id=randomUUID(),filename=id+extension,path=resolve(dataRoot,'audio',filename);writeFileSync(path,await readBody(req,50*1024*1024));
      let metadata;try{metadata=await pythonJSON(config,appRoot,'probe-media.py',[path]);if(!metadata.audio||metadata.duration>1800)throw fault('声音应不超过 30 分钟。');}catch(error){unlinkSync(path);throw fault('声音文件无法读取或超出 30 分钟。');}
      const item={id,filename,type,name:decodeURIComponent(req.headers['x-file-name']||'背景声音').slice(0,180),...metadata};state.audioAssets.push(item);save();send(res,201,item);return true;
    }
    const audio=url.pathname.match(/^\/api\/audio\/([a-f0-9-]+)\/file$/);
    if(audio&&req.method==='GET'){const item=state.audioAssets.find(a=>a.id===audio[1]);if(!item)throw fault('声音不存在。');streamFile(req,res,resolve(dataRoot,'audio',item.filename),item.type);return true;}
    if(url.pathname==='/api/projects/import'&&req.method==='POST'){
      const input=resolve(folder,randomUUID()+'.zip');writeFileSync(input,await readBody(req,500*1024*1024));try{send(res,201,await restore(input));}finally{unlinkSync(input);}return true;
    }
    const pack=url.pathname.match(/^\/api\/projects\/([a-f0-9-]+)\/archive$/);
    if(pack&&req.method==='POST'){
      const project=projectById(pack[1]);if(!project)throw fault('项目不存在。');
      if(state.batchQueue.some(q=>q.projectId===project.id&&['waiting','dispatched'].includes(q.status)))throw fault('请等待项目生成完成后归档。');
      const id=randomUUID(),manifest=resolve(folder,id+'.json');writeFileSync(manifest,JSON.stringify(archiveData(project)));
      const result=await pythonJSON(config,appRoot,'archive-project.py',['pack',manifest,resolve(folder,id+'.zip')]);
      const record={id,projectId:project.id,title:project.name,createdAt:new Date().toISOString(),...result};state.archives.unshift(record);save();send(res,201,record);return true;
    }
    const download=url.pathname.match(/^\/api\/archives\/([a-f0-9-]+)$/);
    if(download&&req.method==='GET'){const item=state.archives.find(a=>a.id===download[1]);if(!item)throw fault('归档不存在。');streamFile(req,res,item.storagePath||resolve(folder,item.id+'.zip'),'application/zip',item.title+'.zip');return true;}
    return false;
  }
  return {handle};
}
