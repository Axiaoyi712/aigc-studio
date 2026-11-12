import {mkdirSync,existsSync,renameSync,writeFileSync,readFileSync,unlinkSync,statSync,realpathSync,openSync,readSync,closeSync} from 'node:fs';
import {resolve,relative,extname,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {localMedia,primaryOutput} from './media.mjs';
import {uploadFile,uploadPath,uploadName} from './uploads.mjs';
import {migrateCatalog,projectAssets} from './asset-catalog.mjs';
const clean=value=>String(value||'未命名').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[ .]+$/g,'').slice(0,28)||'未命名';
const short=id=>String(id).slice(0,8);
export function createStorage(config,state,dataRoot){
 migrateCatalog(state);
 const enabled=Boolean(config.projectStorage),output=resolve(config.comfyRoot,'output'),root=resolve(output,'AIGC项目'),contents=new Map(),hashes=new Map(),relocations=new Map();
 state.mediaIndex??={};for(const [hash,name] of Object.entries(state.mediaIndex)){const path=resolve(output,name);if(path.startsWith(root+sep)&&existsSync(path))contents.set(hash,path);}
 function projectFolder(p){p.storageFolder??=clean(p.name)+'_'+short(p.id);return resolve(root,p.storageFolder);}
 function shotFolder(p,s){s.storageFolder??='镜头'+String(p.shots.indexOf(s)+1).padStart(3,'0')+'_'+clean(s.title)+'_'+short(s.id);return resolve(projectFolder(p),s.storageFolder);}
 function write(path,value){mkdirSync(resolve(path,'..'),{recursive:true});const bytes=typeof value==='string'?value:JSON.stringify(value,null,2);if(existsSync(path)&&readFileSync(path,'utf8')===bytes)return;writeFileSync(path+'.tmp',bytes);renameSync(path+'.tmp',path);}
 function digest(path){const s=statSync(path),key=s.size+':'+s.mtimeMs,old=hashes.get(path);if(old?.key===key)return old.hash;const h=createHash('sha256'),fd=openSync(path,'r'),buffer=Buffer.alloc(1024*1024);try{let n;while((n=readSync(fd,buffer,0,buffer.length,null)))h.update(buffer.subarray(0,n));}finally{closeSync(fd);}const hash=h.digest('hex');hashes.set(path,{key,hash});return hash;}
 function managed(path){if(!path)return false;const roots=[output,resolve(config.comfyRoot,'temp'),resolve(config.comfyRoot,'input/aigc-studio'),resolve(dataRoot,'audio'),resolve(dataRoot,'exports')];const p=resolve(path);return roots.some(r=>p.startsWith(r+sep)&&(!existsSync(p)||realpathSync(p).startsWith(realpathSync(r)+sep)));}
 function intern(source,target){
  if(!source)return null;if(!existsSync(source)){const old=relocations.get(resolve(source));return old&&existsSync(old.path)?old:null;}if(!managed(source)||!resolve(target).startsWith(root+sep))throw Error('拒绝移动项目存储以外的文件。');
  const hash=digest(source),existing=contents.get(hash);let canonical=existing&&existsSync(existing)&&digest(existing)===hash?existing:null;
  if(!canonical){canonical=resolve(source).startsWith(root+sep)?source:target;mkdirSync(resolve(canonical,'..'),{recursive:true});if(source!==canonical){if(existsSync(canonical))throw Error('目标文件已存在，停止迁移：'+canonical);renameSync(source,canonical);}contents.set(hash,canonical);}
  else if(resolve(source).toLowerCase()!==resolve(canonical).toLowerCase())unlinkSync(source);
  const stored={path:canonical,hash,file:{type:'output',subfolder:relative(output,resolve(canonical,'..')).split(sep).join('/'),filename:canonical.split(/[\\/]/).pop()}};relocations.set(resolve(source),stored);state.mediaIndex[hash]=relative(output,canonical).split(sep).join('/');return stored;
 }
 function jobFolder(j){const p=state.projects?.find(p=>p.id===j.projectId),s=p?.shots.find(s=>s.id===j.shotId);if(p&&s)return resolve(shotFolder(p,s),j.section==='video'?'视频':'首帧');if(p)return resolve(projectFolder(p),'其他生成');const existing=j.outputs?.find(f=>f.type==='output'&&f.subfolder?.startsWith('AIGC项目/'));if(existing)return resolve(output,existing.subfolder);if(j.projectId)return resolve(root,'待归类','原项目_'+short(j.projectId),'镜头_'+short(j.shotId));return resolve(root,'独立创作',String(j.createdAt||'未知日期').slice(0,10),j.section==='video'?'视频':'图片');}
 function relocate(source,target){
  if(!source||!existsSync(source))return null;const stored=intern(source,target);if(resolve(stored.path).toLowerCase()===resolve(target).toLowerCase())return stored;
  const old=stored.path;if(!managed(old)||!resolve(target).startsWith(root+sep))throw Error('素材目标目录无效。');if(existsSync(target))throw Error('素材目标已存在：'+target);
  const uploads=Object.values(state.uploads||{}).filter(u=>uploadPath(config,u)?.toLowerCase()===old.toLowerCase()),files=(state.jobs||[]).flatMap(j=>j.outputs||[]).filter(f=>localMedia(config,f)?.toLowerCase()===old.toLowerCase());
  mkdirSync(resolve(target,'..'),{recursive:true});renameSync(old,target);const file={type:'output',subfolder:relative(output,resolve(target,'..')).split(sep).join('/'),filename:target.split(/[\\/]/).pop()};const moved={path:target,hash:stored.hash,file};
  for(const u of uploads)u.file={...file};for(const f of files)Object.assign(f,file);contents.set(stored.hash,target);state.mediaIndex[stored.hash]=relative(output,target).split(sep).join('/');relocations.set(resolve(old),moved);relocations.set(resolve(source),moved);return moved;
 }
 function sync(){
  if(!enabled)return;mkdirSync(root,{recursive:true});for(const [hash,name] of Object.entries(state.mediaIndex))if(!existsSync(resolve(output,name)))delete state.mediaIndex[hash];
  // Prefer the actual generated output to an uploaded copy of that same image.
  for(const j of state.jobs||[])if(!j.deletedAt)for(const f of j.outputs||[]){const path=localMedia(config,f);if(path?.startsWith(root+sep)&&existsSync(path)&&!contents.has(digest(path)))contents.set(digest(path),path);}
  for(const j of state.jobs||[]){if(j.status!=='success'||j.deletedAt)continue;for(const [index,f] of (j.outputs||[]).entries()){if(f.type!=='output')continue;const source=localMedia(config,f);if(!source||!existsSync(source))continue;const p=state.projects?.find(p=>p.id===j.projectId),s=p?.shots.find(s=>s.id===j.shotId),history=s?.[j.section==='video'?'videoHistory':'imageHistory']||[];const name=(j.section==='video'?'视频':'首帧')+'_v'+String(history.indexOf(j.id)+1||1).padStart(3,'0')+'_'+short(j.id)+'_'+index+extname(f.filename);const stored=intern(source,resolve(jobFolder(j),name));Object.assign(f,stored.file,{sha256:stored.hash});}}
  const relocated=new Set();
  for(const a of state.assets||[]){const source=uploadPath(config,state.uploads[a.uploadId]);if(!source||!existsSync(source))continue;const hash=digest(source);if(relocated.has(hash))continue;relocated.add(hash);
   const aliases=state.assets.filter(b=>{const path=uploadPath(config,state.uploads[b.uploadId]);return path&&existsSync(path)&&digest(path)===hash;});const owners=new Set(aliases.map(b=>b.ownerProjectId));
   if(owners.size>1||aliases.some(b=>b.scope==='shared'))for(const b of aliases){b.scope='shared';b.ownerProjectId=null;}
   const owner=state.projects.find(p=>p.id===a.ownerProjectId),category=({character:'角色',scene:'场景',prop:'道具',style:'风格'}[a.category])||'其他';a.storageGroupFolder??=clean(a.groupName||a.name)+'_'+short(a.groupId);
   const placementKey=[a.ownerProjectId||a.scope,a.category,a.groupId].join('/'),keepLocation=a.placementKey===placementKey;if(!keepLocation)a.storageGroupFolder=clean(a.groupName||a.name)+'_'+short(a.groupId);const folder=owner?resolve(projectFolder(owner),category,a.storageGroupFolder):resolve(root,a.scope==='shared'?'公共素材库':'待分类素材',category,a.storageGroupFolder);a.placementKey=placementKey;
   const stored=relocate(source,keepLocation?source:resolve(folder,short(a.id)+extname(source)));if(stored)for(const b of aliases){b.placementKey=[b.ownerProjectId||b.scope,b.category,b.groupId].join('/');const u=state.uploads[b.uploadId];u.file={...stored.file};u.sha256=stored.hash;}
  }
  for(const [id,u] of Object.entries(state.uploads||{})){
   const path=uploadPath(config,u),asset=state.assets?.find(a=>a.uploadId===id);
   if(asset)continue;
   const folder=resolve(root,'公共素材库',({character:'角色',scene:'场景',prop:'道具',style:'风格'}[asset?.category])||'上传');
   const stored=intern(path,resolve(folder,(asset?clean(asset.name)+'_':'')+short(id)+extname(u.file?.filename||u.name)));
   if(stored){u.file=stored.file;u.sha256=stored.hash;}
  }
  for(const a of state.assets||[]){const u=state.uploads[a.uploadId];if(u?.file?.type==='output'){a.libraryFile=[u.file.subfolder,u.file.filename].filter(Boolean).join('/');a.projectFiles={};}}
  for(const p of state.projects||[]){
   const base=projectFolder(p);for(const name of ['项目资料','角色','场景','道具','风格','音频','成片'])mkdirSync(resolve(base,name),{recursive:true});p.storageInitialized=true;
   const ids=new Set(projectAssets(state,p).map(a=>a.id));
   for(const id of ids){const a=state.assets?.find(a=>a.id===id);if(a?.libraryFile){a.projectFiles[p.id]=a.libraryFile;write(resolve(base,'项目资料','素材_'+short(a.id)+'.json'),{id:a.id,name:a.name,file:a.libraryFile});}}
   for(const r of p.characters||[]){const g=p.catalog?.find(g=>g.id===r.groupId),a=state.assets.find(a=>g?.assetIds.includes(a.id));write(resolve(base,'角色',g?.folderPath||a?.storageGroupFolder||clean(r.name)+'_'+short(r.groupId||r.id),'人物设定.txt'),r.name+'\n'+(r.description||'')+'\n'+(r.identity||'')+'\n'+(r.wardrobe||''));}
   for(const s of p.shots){const folder=shotFolder(p,s);for(const name of ['首帧','视频'])mkdirSync(resolve(folder,name),{recursive:true});write(resolve(folder,'镜头说明.txt'),['镜头：'+s.title,'总提示词：'+(s.generalPrompt||''),'首帧描述：'+s.imagePrompt,'视频描述：'+s.videoPrompt,'已确认首帧任务：'+(s.confirmedFrameJobId||'未确认'),'选用视频任务：'+(s.videoJobId||'未选用'),JSON.stringify(s.director||{},null,2)].join('\n'));}
  }
  for(const a of state.audioAssets||[]){const stored=intern(a.storagePath||resolve(dataRoot,'audio',a.filename),resolve(root,'公共素材库','音频',a.id+extname(a.filename)));if(stored)a.storagePath=stored.path;}
  for(const p of state.projects||[]){const base=projectFolder(p);for(const e of (state.exports||[]).filter(e=>e.projectId===p.id&&e.status==='success')){const stored=intern(e.storagePath||resolve(dataRoot,'exports',e.id+'.mp4'),resolve(base,'成片','成片_'+short(e.id)+'.mp4'));if(stored)e.storagePath=stored.path;}
   write(resolve(base,'项目资料','项目记录.json'),{schemaVersion:2,project:p,assets:(state.assets||[]).filter(a=>a.projectFiles?.[p.id]),jobs:(state.jobs||[]).filter(j=>j.projectId===p.id&&!j.deletedAt),exports:(state.exports||[]).filter(e=>e.projectId===p.id),mediaPolicy:'single-file-reference'});
  }
 }
 function prefix(context,id,section){if(!enabled)return null;const p=state.projects?.find(p=>p.id===context.projectId),s=p?.shots.find(s=>s.id===context.shotId);const folder=p&&s?resolve(shotFolder(p,s),section==='video'?'视频':'首帧'):resolve(root,'独立创作',new Date().toLocaleDateString('sv-SE'),section==='video'?'视频':'图片');return relative(output,resolve(folder,id)).split(sep).join('/');}
 function imageName(pid,id){return uploadName(state.uploads[id]);}
 async function handle(req,res,url,send){const m=url.pathname.match(/^\/api\/(projects|jobs|assets)\/([a-f0-9-]+)\/folder$/);if(req.method!=='POST'||!m)return false;if(!enabled)throw Object.assign(Error('项目文件夹未启用。'),{status:400});let path,file;
  if(m[1]==='projects'){const p=state.projects.find(p=>p.id===m[2]);if(p){const sid=url.searchParams.get('shotId'),s=p.shots.find(s=>s.id===sid);if(sid&&!s)throw Object.assign(Error('镜头不存在。'),{status:404});path=s?shotFolder(p,s):projectFolder(p);}}
  if(m[1]==='jobs'){const j=state.jobs.find(j=>j.id===m[2]),f=primaryOutput(j);if(f)path=resolve(localMedia(config,f),'..');}
  if(m[1]==='assets'){const a=state.assets.find(a=>a.id===m[2]);file=uploadPath(config,state.uploads[a?.uploadId]);if(file&&existsSync(file))path=resolve(file,'..');else throw Object.assign(Error('原文件已丢失，请重新关联图片。'),{status:404});}
  if(!path||!existsSync(path))throw Object.assign(Error('文件夹不存在。'),{status:404});
  const selectedFile=file&&!url.searchParams.has('group');
  const opened=await new Promise((ok,reject)=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-STA','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./scripts/reveal-file.ps1',import.meta.url)),'-LiteralPath',selectedFile?file:path],{windowsHide:true,timeout:15000},(error,stdout)=>{
   if(error){reject(Object.assign(Error('打开文件位置失败，请复制路径查看：'+(selectedFile?file:path)),{status:500}));return;}
   try{ok(JSON.parse(stdout));}catch{reject(Object.assign(Error('无法确认资源管理器状态，请复制路径查看：'+path),{status:500}));}
  }));
  send(res,200,{path,file,focused:opened.focused,reused:opened.reused,message:opened.focused?(selectedFile?'已定位原文件':'已切换到文件夹'):'文件夹已打开，请从任务栏切换到资源管理器'});return true;
 }
 return {sync,prefix,imageName,handle,root,projectFolder,shotFolder,managed,digest,storeFile:intern,relocate};
}
