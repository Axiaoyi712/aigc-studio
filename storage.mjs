import {mkdirSync,existsSync,copyFileSync,renameSync,writeFileSync,readFileSync,unlinkSync,constants} from 'node:fs';
import {resolve,relative,extname,sep} from 'node:path';
import {spawn} from 'node:child_process';
import {localMedia} from './media.mjs';
const clean=value=>String(value||'未命名').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[ .]+$/g,'').slice(0,28)||'未命名';
const short=id=>String(id).slice(0,8);
export function createStorage(config,state,dataRoot){
 const enabled=Boolean(config.projectStorage),root=resolve(config.comfyRoot,'output/AIGC项目');
 const category={character:'角色',scene:'场景',prop:'道具',style:'风格'};
 function projectFolder(p){p.storageFolder??=clean(p.name)+'_'+short(p.id);return resolve(root,p.storageFolder);}
 function shotFolder(p,s){s.storageFolder??='镜头'+String(p.shots.indexOf(s)+1).padStart(3,'0')+'_'+clean(s.title)+'_'+short(s.id);return resolve(projectFolder(p),s.storageFolder);}
 function write(path,value){mkdirSync(resolve(path,'..'),{recursive:true});const bytes=typeof value==='string'?value:JSON.stringify(value,null,2);if(existsSync(path)&&readFileSync(path,'utf8')===bytes)return;writeFileSync(path+'.tmp',bytes);renameSync(path+'.tmp',path);}
 function copy(source,target){if(!source||!existsSync(source))return false;mkdirSync(resolve(target,'..'),{recursive:true});if(!existsSync(target))copyFileSync(source,target);return true;}
 function move(source,target){if(source===target||!existsSync(source))return;mkdirSync(resolve(target,'..'),{recursive:true});if(existsSync(target))throw Error('项目目标文件已存在：'+target);try{renameSync(source,target);}catch(error){if(error.code!=='EXDEV')throw error;copyFileSync(source,target,constants.COPYFILE_EXCL);unlinkSync(source);}}
 function jobFolder(j){const p=state.projects?.find(p=>p.id===j.projectId),s=p?.shots.find(s=>s.id===j.shotId);if(p&&s)return resolve(shotFolder(p,s),j.section==='video'?'视频':'首帧');if(p)return resolve(projectFolder(p),'其他生成');const existing=j.outputs?.find(f=>f.type==='output'&&f.subfolder?.startsWith('AIGC项目/'));if(existing)return resolve(config.comfyRoot,'output',existing.subfolder);if(j.projectId)return resolve(root,'待归类','原项目_'+short(j.projectId),'镜头_'+short(j.shotId));return resolve(root,'独立创作',String(j.createdAt||'未知日期').slice(0,10),j.section==='video'?'视频':'图片');}
 function sync(){
  if(!enabled)return;
  mkdirSync(root,{recursive:true});
  for(const p of state.projects||[]){
   const base=projectFolder(p);for(const name of ['项目资料','角色','场景','道具','音频','成片','归档'])mkdirSync(resolve(base,name),{recursive:true});
   const bindings=new Map();
   for(const r of p.characters||[])for(const id of r.referenceIds||[])if(!bindings.has(id))bindings.set(id,resolve(base,'角色',clean(r.name)+'_'+short(r.id)));
   const ids=new Set([...(p.production?.referenceIds||[]),...p.shots.flatMap(s=>s.referenceIds||[]),...bindings.keys()]);
   for(const id of ids){const a=state.assets?.find(a=>a.id===id),u=state.uploads[a?.uploadId];if(!a||!u)continue;const source=resolve(config.comfyRoot,'input',u.name),folder=bindings.get(id)||resolve(base,category[a.category]||'其他参考',clean(a.name)+'_'+short(a.id));const target=resolve(folder,'参考_'+short(a.id)+extname(u.name));if(copy(source,target)){a.projectFiles??={};a.projectFiles[p.id]=relative(resolve(config.comfyRoot,'output'),target).split(sep).join('/');}}
   for(const r of p.characters||[])write(resolve(base,'角色',clean(r.name)+'_'+short(r.id),'人物设定.txt'),r.name+'\n'+(r.description||'')+'\n'+(r.identity||'')+'\n'+(r.wardrobe||''));
   for(const s of p.shots){const folder=shotFolder(p,s);for(const name of ['首帧','视频'])mkdirSync(resolve(folder,name),{recursive:true});write(resolve(folder,'镜头说明.txt'),['镜头：'+s.title,'总提示词：'+(s.generalPrompt||''),'首帧描述：'+s.imagePrompt,'视频描述：'+s.videoPrompt,'已确认首帧任务：'+(s.confirmedFrameJobId||'未确认'),'选用视频任务：'+(s.videoJobId||'未选用'),JSON.stringify(s.director||{},null,2)].join('\n'));}
   const audio=state.audioAssets?.find(a=>a.id===p.production?.backgroundAudioId);if(audio)copy(resolve(dataRoot,'audio',audio.filename),resolve(base,'音频',clean(audio.name)+'_'+short(audio.id)+extname(audio.filename)));
  }
  for(const a of state.assets||[]){if(Object.keys(a.projectFiles||{}).length)continue;const u=state.uploads[a.uploadId];if(!u)continue;const target=resolve(root,'公共素材库',category[a.category]||'其他',clean(a.name)+'_'+short(a.id)+extname(u.name));if(copy(resolve(config.comfyRoot,'input',u.name),target))a.libraryFile=relative(resolve(config.comfyRoot,'output'),target).split(sep).join('/');}
  for(const j of state.jobs||[]){if(j.status!=='success')continue;for(const [index,f] of (j.outputs||[]).entries()){if(f.type!=='output')continue;const source=localMedia(config,f);if(!source||!existsSync(source))continue;const folder=jobFolder(j);const p=state.projects?.find(p=>p.id===j.projectId),s=p?.shots.find(s=>s.id===j.shotId),history=s?.[j.section==='video'?'videoHistory':'imageHistory']||[];const n=history.indexOf(j.id)+1;const name=(j.section==='video'?'视频':'首帧')+'_v'+String(n||1).padStart(3,'0')+'_'+short(j.id)+'_'+index+extname(f.filename);const target=resolve(folder,name);move(source,target);f.subfolder=relative(resolve(config.comfyRoot,'output'),folder).split(sep).join('/');f.filename=name;}}
  for(const p of state.projects||[]){const base=projectFolder(p);for(const e of (state.exports||[]).filter(e=>e.projectId===p.id&&e.status==='success')){const target=resolve(base,'成片','成片_'+short(e.id)+'.mp4');move(e.storagePath||resolve(dataRoot,'exports',e.id+'.mp4'),target);if(existsSync(target))e.storagePath=target;}for(const a of (state.archives||[]).filter(a=>a.projectId===p.id)){const target=resolve(base,'归档','项目归档_'+short(a.id)+'.zip');move(a.storagePath||resolve(dataRoot,'archives',a.id+'.zip'),target);if(existsSync(target))a.storagePath=target;}
   write(resolve(base,'项目资料','项目记录.json'),{schemaVersion:1,project:p,assets:(state.assets||[]).filter(a=>a.projectFiles?.[p.id]),jobs:(state.jobs||[]).filter(j=>j.projectId===p.id),exports:(state.exports||[]).filter(e=>e.projectId===p.id)});
  }
 }
 function prefix(context,id,section){if(!enabled)return null;const p=state.projects?.find(p=>p.id===context.projectId),s=p?.shots.find(s=>s.id===context.shotId);const folder=p&&s?resolve(shotFolder(p,s),section==='video'?'视频':'首帧'):resolve(root,'独立创作',new Date().toLocaleDateString('sv-SE'),section==='video'?'视频':'图片');return relative(resolve(config.comfyRoot,'output'),resolve(folder,id)).split(sep).join('/');}
 function imageName(pid,id){const a=state.assets?.find(a=>a.uploadId===id);return enabled&&a?.projectFiles?.[pid]?a.projectFiles[pid]+' [output]':state.uploads[id].name;}
 async function handle(req,res,url,send){const m=url.pathname.match(/^\/api\/(projects|jobs|assets)\/([a-f0-9-]+)\/folder$/);if(req.method!=='POST'||!m)return false;if(!enabled)throw Object.assign(Error('项目文件夹未启用。'),{status:400});let path;
  if(m[1]==='projects'){const p=state.projects.find(p=>p.id===m[2]);if(p){const sid=url.searchParams.get('shotId'),s=p.shots.find(s=>s.id===sid);if(sid&&!s)throw Object.assign(Error('镜头不存在。'),{status:404});path=s?shotFolder(p,s):projectFolder(p);}}
  if(m[1]==='jobs'){const j=state.jobs.find(j=>j.id===m[2]);if(j)path=jobFolder(j);}
  if(m[1]==='assets'){const a=state.assets.find(a=>a.id===m[2]),file=Object.values(a?.projectFiles||{})[0]||a?.libraryFile;if(file)path=resolve(config.comfyRoot,'output',file,'..');}
  if(!path||!existsSync(path))throw Object.assign(Error('文件夹不存在。'),{status:404});const child=spawn('explorer.exe',[path],{windowsHide:true,stdio:'ignore'});child.on('error',()=>{});child.unref();send(res,200,{path});return true;
 }
 return {sync,prefix,imageName,handle,root};
}
