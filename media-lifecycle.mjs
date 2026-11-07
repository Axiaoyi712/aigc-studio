import {existsSync,unlinkSync,rmSync,realpathSync} from 'node:fs';
import {resolve,sep} from 'node:path';
import {localMedia} from './media.mjs';
import {uploadPath} from './uploads.mjs';
import {pruneCatalog} from './asset-catalog.mjs';
const fault=message=>Object.assign(Error(message),{status:400});
export function createMediaLifecycle({state,config,dataRoot,storage}){
 const key=path=>path?resolve(path).toLowerCase():'';
 const output=resolve(config.comfyRoot,'output'),root=storage.root;
 function safe(path){
  const p=resolve(path),roots=[output,resolve(config.comfyRoot,'temp'),resolve(config.comfyRoot,'input/aigc-studio'),resolve(dataRoot,'audio'),resolve(dataRoot,'archives'),resolve(dataRoot,'exports')];
  if(!roots.some(r=>key(p).startsWith(key(r)+sep)&&(!existsSync(p)||key(realpathSync(p)).startsWith(key(realpathSync(r))+sep))))throw fault('拒绝删除工作台管理范围以外的文件。');return p;
 }
 function detach(paths,stamp=new Date().toISOString()){
  const targets=new Set(paths.filter(Boolean).map(key)),affectedJobs=new Set(),affectedUploads=new Set(),affectedAssets=new Set();let filesDeleted=0;
  const allowed=[...targets].map(safe); // Validate the complete set before any mutation.
  for(const path of allowed)if(existsSync(path)){unlinkSync(path);filesDeleted++;}
  for(const j of state.jobs||[])if((j.outputs||[]).some(f=>targets.has(key(localMedia(config,f))))){j.deletedAt??=stamp;j.deletedReason='permanent-media-deletion';j.outputs=[];affectedJobs.add(j.id);}
  for(const [id,u] of Object.entries(state.uploads||{}))if(targets.has(key(uploadPath(config,u)))){affectedUploads.add(id);delete state.uploads[id];}
  for(const a of state.assets||[])if(affectedUploads.has(a.uploadId))affectedAssets.add(a.id);
  state.assets=(state.assets||[]).filter(a=>!affectedAssets.has(a.id));
  for(const p of state.projects||[]){
   if(p.production){p.production.referenceIds=(p.production.referenceIds||[]).filter(id=>!affectedAssets.has(id));for(const id of affectedAssets)delete p.production.referenceNotes?.[id];}
   for(const r of p.characters||[])r.referenceIds=(r.referenceIds||[]).filter(id=>!affectedAssets.has(id));
   for(const s of p.shots){
    s.referenceIds=(s.referenceIds||[]).filter(id=>!affectedAssets.has(id));
    for(const name of ['imageHistory','videoHistory'])s[name]=(s[name]||[]).filter(id=>!affectedJobs.has(id));
    for(const name of ['imageJobId','confirmedFrameJobId','videoJobId'])if(affectedJobs.has(s[name]))s[name]=null;
   }
  }
  for(const j of state.jobs||[])j.images=(j.images||[]).filter(id=>!affectedUploads.has(id));
  for(const q of state.batchQueue||[])if(affectedJobs.has(q.id)||affectedJobs.has(q.frameJobId)||(q.input?.images||[]).some(id=>affectedUploads.has(id))){q.status='cancelled';q.error='关联媒体已彻底删除。';}
  state.exports=(state.exports||[]).filter(e=>!targets.has(key(e.storagePath||resolve(dataRoot,'exports',e.id+'.mp4'))));
  const audioIds=new Set((state.audioAssets||[]).filter(a=>targets.has(key(a.storagePath||resolve(dataRoot,'audio',a.filename)))).map(a=>a.id));
  state.audioAssets=(state.audioAssets||[]).filter(a=>!audioIds.has(a.id));for(const p of state.projects||[])if(audioIds.has(p.production?.backgroundAudioId))p.production.backgroundAudioId=null;
  pruneCatalog(state);
  return {filesDeleted,affectedJobIds:[...affectedJobs],affectedUploadIds:[...affectedUploads]};
 }
 function removeJobs(ids){
  const jobs=ids.map(id=>state.jobs.find(j=>j.id===id)).filter(Boolean),paths=jobs.flatMap(j=>(j.outputs||[]).filter(f=>['output','temp'].includes(f.type)).map(f=>localMedia(config,f)));
  const stamp=new Date().toISOString(),result=detach(paths,stamp);for(const j of jobs){j.deletedAt??=stamp;j.deletedReason='permanent-media-deletion';j.outputs=[];}
  const selected=new Set(ids);for(const p of state.projects||[])for(const s of p.shots){for(const name of ['imageHistory','videoHistory'])s[name]=(s[name]||[]).filter(id=>!selected.has(id));for(const name of ['imageJobId','confirmedFrameJobId','videoJobId'])if(selected.has(s[name]))s[name]=null;}
  return result;
 }
 function removeProject(id){
  const p=state.projects.find(p=>p.id===id);if(!p)return;
  const folder=storage.projectFolder(p);if(!folder.startsWith(root+sep)||existsSync(folder)&&!realpathSync(folder).startsWith(realpathSync(root)+sep))throw fault('项目目录无效，拒绝删除。');
  const owned=state.assets.filter(a=>a.ownerProjectId===id),sharedUploads=new Set(state.assets.filter(a=>a.ownerProjectId!==id).map(a=>a.uploadId));
  const jobs=state.jobs.filter(j=>j.projectId===id),extras=[...(state.exports||[]).filter(e=>e.projectId===id).map(e=>e.storagePath||resolve(dataRoot,'exports',e.id+'.mp4')),...owned.filter(a=>!sharedUploads.has(a.uploadId)).map(a=>uploadPath(config,state.uploads[a.uploadId]))];
  // Validate extras before deleting any project output.
  const sharedPaths=new Set(state.assets.filter(a=>a.ownerProjectId!==id).map(a=>key(uploadPath(config,state.uploads[a.uploadId]))));
  const retained=jobs.filter(j=>(j.outputs||[]).some(f=>sharedPaths.has(key(localMedia(config,f)))));
  extras.filter(Boolean).forEach(safe);removeJobs(jobs.filter(j=>!retained.includes(j)).map(j=>j.id));detach(extras);
  for(const j of retained){j.deletedAt=new Date().toISOString();j.outputs=[];for(const other of state.projects)for(const s of other.shots){s.imageHistory=(s.imageHistory||[]).filter(x=>x!==j.id);s.videoHistory=(s.videoHistory||[]).filter(x=>x!==j.id);for(const name of ['imageJobId','confirmedFrameJobId','videoJobId'])if(s[name]===j.id)s[name]=null;}}
  state.projects=state.projects.filter(p=>p.id!==id);state.batchQueue=(state.batchQueue||[]).filter(q=>q.projectId!==id);
  if(existsSync(folder))rmSync(folder,{recursive:true,force:true});
 }
 function reconcile(){
  if(!config.projectStorage||!existsSync(output))return false;let changed=false;
  for(const p of [...(state.projects||[])])if(p.storageInitialized&&!existsSync(storage.projectFolder(p))){removeProject(p.id);changed=true;}
  const missing=[];
  for(const j of state.jobs||[])if(j.status==='success'&&!j.deletedAt)for(const f of j.outputs||[]){const path=localMedia(config,f);if(f.type==='output'&&path&&!existsSync(path))missing.push(path);}
  for(const u of Object.values(state.uploads||{}))if(u.file?.type==='output'){const path=uploadPath(config,u);if(path&&!existsSync(path))missing.push(path);}
  for(const e of state.exports||[])if(e.status==='success'&&e.storagePath&&!existsSync(e.storagePath))missing.push(e.storagePath);
  if(missing.length){detach(missing);changed=true;}return changed;
 }
 return {removeJobs,removeProject,reconcile,detach};
}
