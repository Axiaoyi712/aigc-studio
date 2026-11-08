import {existsSync,statSync,realpathSync,readFileSync,mkdirSync,copyFileSync,unlinkSync,readdirSync,constants} from 'node:fs';
import {resolve,relative,dirname,basename,extname,sep,isAbsolute} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {localMedia,primaryOutput} from './media.mjs';
import {uploadPath} from './uploads.mjs';
import {projectAssets} from './asset-catalog.mjs';
import {shotPlan} from './production.mjs';

const fault=(message,status=400)=>Object.assign(Error(message),{status});
const image=/\.(png|jpe?g|webp)$/i;
const within=(path,root)=>resolve(path).toLowerCase().startsWith(resolve(root).toLowerCase()+sep);
const mime={PNG:'image/png',JPEG:'image/jpeg',WEBP:'image/webp'};

export function inspectImage(config,appRoot,path){
 if(!path||!isAbsolute(path)||!image.test(path))throw fault('请选择 PNG、JPEG 或 WebP 图片。');
 let before;try{before=statSync(path);}catch{throw fault('图片文件不存在，请重新选择。',404);}
 if(!before.isFile()||before.size===0||before.size>20*1024*1024)throw fault('图片大小必须在 0～20MB 内。');
 const python=config.pythonPath||resolve(config.comfyRoot,'../python_embeded/python.exe');let info;
 try{info=JSON.parse(execFileSync(python,[resolve(appRoot,'image-info.py'),path],{encoding:'utf8',env:{...process.env,PYTHONIOENCODING:'utf-8'},stdio:['ignore','pipe','pipe'],windowsHide:true,timeout:20000,maxBuffer:16384}));}
 catch(error){const detail=String(error.stderr||'').trim();throw fault(detail||'图片无法解码，请检查图片是否完整以及本机 Python/Pillow 是否可用。');}
 const bytes=readFileSync(path),after=statSync(path);
 if(before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw fault('图片正在变化，请待文件保存完成后重试。',409);
 return {...info,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:after.size};
}

export function createExternalFrames({state,config,storage,save,send,readBody,appRoot,isBusy}){
 const isExternal=job=>job?.source==='external'&&job?.template==='external-frame';
 const findProject=id=>state.projects?.find(p=>p.id===id)||(()=>{throw fault('项目不存在。',404);})();
 const inspect=value=>inspectImage(config,appRoot,typeof value==='string'?value:localMedia(config,primaryOutput(value)));
 const publicJob=job=>({...job,outputs:(job.outputs||[]).map(f=>({...f,url:'/api/media/'+job.id+'/'+f.index+(f.contentVersion?'?v='+f.contentVersion:'')}))});
 function idle(){if(isBusy?.()||(state.jobs||[]).some(j=>['submitting','queued','running','recovering'].includes(j.status))||(state.batchQueue||[]).some(q=>['waiting','dispatched'].includes(q.status)))throw fault('请等待生成、排队或导出完成，再导入首帧。',409);}
 function repoint(old,file){for(const u of Object.values(state.uploads||{}))if(uploadPath(config,u)?.toLowerCase()===old.toLowerCase())u.file={...file};for(const j of state.jobs||[])for(const o of j.outputs||[])if(localMedia(config,o)?.toLowerCase()===old.toLowerCase())Object.assign(o,file);}
 function register(project,shot,path,options={}){
  if(!project.shots?.includes(shot))throw fault('镜头不属于当前项目。');
  const info=inspect(path);if(!storage.managed(path))throw fault('请先将外部图片导入项目，再登记候选。');
  const target=resolve(storage.shotFolder(project,shot),'首帧',randomUUID()+extname(path).toLowerCase());
  const stored=storage.storeFile(path,target);if(!stored)throw fault('图片文件不存在。',404);repoint(path,stored.file);
  const old=(shot.imageHistory||[]).map(id=>state.jobs.find(j=>j.id===id)).find(j=>isExternal(j)&&!j.deletedAt&&j.status==='success'&&j.externalFrame?.sha256===info.sha256);
  let job=old;
  if(!job){const now=new Date().toISOString();job={id:randomUUID(),source:'external',template:'external-frame',section:'image',title:'外部首帧 · '+(options.name||basename(path)),status:'success',projectId:project.id,shotId:shot.id,size:info.width+'x'+info.height,createdAt:now,finishedAt:now,externalFrame:{origin:options.origin||'folder',name:options.name||basename(path),...info,...(options.sourceJobId?{sourceJobId:options.sourceJobId}:{})},outputs:[{index:0,kind:'image',...stored.file,sha256:info.sha256,metadata:{width:info.width,height:info.height}}]};state.jobs.push(job);}
  else {Object.assign(primaryOutput(job),stored.file,{sha256:info.sha256});Object.assign(job.externalFrame,info,{invalid:false});}
  shot.imageHistory??=[];if(!shot.imageHistory.includes(job.id))shot.imageHistory.push(job.id);
  shot.imageJobId=job.id;shot.confirmedFrameJobId=null;shot.frameApproval=null;
  return job;
 }
 function approve(project,shot,job){
  if(!isExternal(job)||job.deletedAt||job.status!=='success'||!shot.imageHistory?.includes(job.id)||job.projectId!==project.id||job.shotId!==shot.id)throw fault('请从本镜头的候选首帧中选择图片。');
  const info=inspect(job);if(job.externalFrame.invalid||info.sha256!==job.externalFrame.sha256||info.sha256!==primaryOutput(job)?.sha256)throw fault('图片内容已更改，请重新导入并确认后再生成视频。',409);
  shot.imageJobId=job.id;shot.confirmedFrameJobId=job.id;shot.frameApproval={jobId:job.id,sha256:info.sha256,frameSignature:shotPlan(project,shot,projectAssets(state,project)).frameSignature};
  return job;
 }
 function walk(folder){if(!existsSync(folder))return [];const list=[];for(const entry of readdirSync(folder,{withFileTypes:true})){if(entry.isSymbolicLink()||entry.name.startsWith('.'))continue;const path=resolve(folder,entry.name);if(entry.isDirectory())list.push(...walk(path));else if(entry.isFile()&&image.test(entry.name))list.push(path);}return list;}
 function frameFile(project,path){const base=storage.projectFolder(project);if(!within(path,base)||!existsSync(path)||!within(realpathSync(path),realpathSync(base))||!project.shots.some(s=>within(path,resolve(storage.shotFolder(project,s),'首帧'))))throw fault('请选择当前项目首帧目录中的图片。');return path;}
 function sources(project){
  const result=[];
  const available=path=>{try{const s=statSync(path);return s.isFile()&&s.size>0&&s.size<=20*1024*1024&&image.test(path);}catch{return false;}};
  for(const job of state.jobs||[]){const file=primaryOutput(job),path=localMedia(config,file);if(job.status!=='success'||job.deletedAt||job.section==='video'||job.externalFrame?.invalid||file?.kind!=='image'||!available(path))continue;const size=file.metadata||job.externalFrame||{};result.push({id:job.id,type:'job',name:job.title||file.filename,url:'/api/media/'+job.id+'/'+file.index+(file.contentVersion?'?v='+file.contentVersion:''),width:size.width,height:size.height});}
  for(const asset of projectAssets(state,project)){const path=uploadPath(config,state.uploads[asset.uploadId]);if(available(path))result.push({id:asset.id,type:'asset',name:asset.name,url:'/api/uploads/'+asset.uploadId});}
  for(const shot of project.shots)for(const path of walk(resolve(storage.shotFolder(project,shot),'首帧'))){try{frameFile(project,path);if(!available(path))continue;const name=relative(storage.projectFolder(project),path).split(sep).join('/');result.push({id:name,type:'file',name:shot.title+' / '+basename(path),url:'/api/project-file/'+project.id+'?path='+encodeURIComponent(name)});}catch{}}
  return result;
 }
 async function handle(req,res,url){
  if(url.pathname==='/api/frames/inspect'&&req.method==='POST'){
   const {localPath}=JSON.parse((await readBody(req)).toString('utf8'));
   if(typeof localPath!=='string'||!isAbsolute(localPath.trim()))throw fault('请输入图片的完整本地路径。');
   let path;try{path=realpathSync(localPath.trim());}catch{throw fault('图片文件不存在，请重新选择。',404);}
   const info=inspect(path);send(res,200,{path,name:basename(path),width:info.width,height:info.height,dataUrl:'data:'+mime[info.format]+';base64,'+readFileSync(path).toString('base64')});return true;
  }
  const match=url.pathname.match(/^\/api\/projects\/([^/]+)\/frames\/(sources|import)$/);if(!match)return false;
  const project=findProject(match[1]);if(match[2]==='sources'&&req.method==='GET'){send(res,200,sources(project));return true;}
  if(match[2]!=='import'||req.method!=='POST')throw fault('接口不存在。',404);idle();const body=JSON.parse((await readBody(req)).toString('utf8'));
  const shot=project.shots.find(s=>s.id===body.shotId);if(!shot)throw fault('镜头不存在。',404);
  const keys=['uploadId','jobId','assetId','relativePath','localPath'].filter(k=>typeof body[k]==='string'&&body[k].trim());if(keys.length!==1)throw fault('一次请选择一个首帧来源。');
  if(body.mode!==undefined&&!['copy','move'].includes(body.mode))throw fault('导入方式无效。');
  let path,origin=keys[0],sourceJobId;
  if(origin==='jobId'){const job=state.jobs.find(j=>j.id===body.jobId),file=primaryOutput(job);if(job?.status!=='success'||job.deletedAt||job.section==='video'||file?.kind!=='image')throw fault('请选择已完成的图片作品。');path=localMedia(config,file);sourceJobId=job.id;origin='job';}
  else if(origin==='assetId'){const asset=projectAssets(state,project).find(a=>a.id===body.assetId);if(!asset)throw fault('素材不属于当前项目。');path=uploadPath(config,state.uploads[asset.uploadId]);origin='asset';}
  else if(origin==='uploadId'){path=uploadPath(config,state.uploads[body.uploadId]);origin='upload';}
  else if(origin==='relativePath'){path=frameFile(project,resolve(storage.projectFolder(project),body.relativePath));origin='folder';}
  else{path=body.localPath.trim();if(!isAbsolute(path))throw fault('请输入图片的完整本地路径。');try{path=realpathSync(path);}catch{throw fault('图片文件不存在，请重新选择。',404);}origin='file';}
  const info=inspect(path);let imported=path,removeSource=false;
  if(!storage.managed(path)){
   imported=resolve(storage.shotFolder(project,shot),'首帧',randomUUID()+extname(path).toLowerCase());mkdirSync(dirname(imported),{recursive:true});
   copyFileSync(path,imported,constants.COPYFILE_EXCL);
   try{if(inspect(imported).sha256!==info.sha256)throw fault('导入图片校验失败，请重试。');}catch(error){unlinkSync(imported);throw error;}
   removeSource=body.mode==='move';
  }
  const frame=register(project,shot,imported,{origin,name:basename(String(body.name||basename(path))).slice(0,160),sourceJobId});
  if(removeSource){if(inspect(path).sha256!==info.sha256)throw fault('原图片已变化，已保留原图，请重新检查。',409);unlinkSync(path);}
  save();send(res,200,{shot,frame:publicJob(frame)});return true;
 }
 return {handle,register,inspect,approve,isExternal};
}
