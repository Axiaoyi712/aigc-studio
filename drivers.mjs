import {randomUUID,createHash} from 'node:crypto';
import {resolve,extname,basename,relative,sep,isAbsolute} from 'node:path';
import {existsSync,mkdirSync,realpathSync,statSync,createReadStream,createWriteStream,unlinkSync} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';
import {pythonJSON,streamFile} from './project-files.mjs';
import {normalizeProduction} from './public/director-options.js';
const fault=(message,status=400)=>Object.assign(Error(message),{status});
const extensions=new Set(['.mp4','.mov','.mkv','.webm','.avi']);
const fingerprint=path=>{const s=statSync(path);return {bytes:s.size,mtime:s.mtimeMs};};

export function createDrivers({state,save,config,appRoot,storage,send,readBody}){
 state.driverVideos??=[];state.driverClips??=[];
 const active=new Set();
 const project=id=>state.projects.find(p=>p.id===id)||(()=>{throw fault('项目不存在。',404);})();
 function source(video){
  if(!existsSync(video.sourcePath))throw fault('原视频已移动或删除，请从新位置重新关联。');
  const current=fingerprint(video.sourcePath);
  if(current.bytes!==video.bytes||current.mtime!==video.mtime)throw fault('原视频已被修改，请重新关联以免使用旧片段。');
  return video.sourcePath;
 }
 function clip(id,pid){
  const item=state.driverClips.find(c=>c.id===id&&c.projectId===pid);
  if(!item)throw fault('驱动片段不存在或不属于当前项目。');
  source(state.driverVideos.find(v=>v.id===item.videoId)||(()=>{throw fault('原视频记录缺失。');})());
  if(!existsSync(resolve(config.comfyRoot,'output',item.file)))throw fault('驱动片段缓存缺失，请重新准备。');
  return item;
 }
 async function handle(req,res,url){
  const cached=url.pathname.match(/^\/api\/projects\/([a-f0-9-]+)\/driver-clips\/([a-f0-9-]+)\/file$/);
  if(cached&&req.method==='GET'){project(cached[1]);const c=clip(cached[2],cached[1]);streamFile(req,res,resolve(config.comfyRoot,'output',c.file),'video/mp4');return true;}
  const match=url.pathname.match(/^\/api\/projects\/([a-f0-9-]+)\/drivers(?:\/([a-f0-9-]+)(?:\/(file|clips))?)?$/);
  if(!match)return false;
  const p=project(match[1]),id=match[2],action=match[3];
  if(req.method==='GET'&&!id){send(res,200,state.driverVideos.filter(v=>v.projectId===p.id));return true;}
  const video=id&&state.driverVideos.find(v=>v.id===id&&v.projectId===p.id);
  if(id&&!video)throw fault('驱动视频不存在。',404);
  if(req.method==='GET'&&action==='file'){streamFile(req,res,source(video),video.type||'video/mp4');return true;}
  if(req.method!=='POST')throw fault('驱动操作无效。');
  if(active.has(p.id))throw fault('正在准备此项目的驱动片段，请稍候。',409);
  if(state.batchQueue.some(q=>q.projectId===p.id&&['waiting','dispatched'].includes(q.status)))throw fault('请等待项目队列完成后再导入驱动。',409);
  active.add(p.id);
  let temporary;
  try{
   if(!id){
    const vid=randomUUID();let path;
    const uploaded=req.headers['content-type']?.split(';')[0]!=='application/json';
    if(uploaded){
     const name=decodeURIComponent(req.headers['x-file-name']||'');const extension=extname(name).toLowerCase();
     if(!extensions.has(extension))throw fault('支持MP4、MOV、MKV、WEBM、AVI。');
     const folder=resolve(storage.projectFolder(p),'驱动素材');mkdirSync(folder,{recursive:true});
     path=resolve(folder,vid+extension);temporary=path;
     let bytes=0;const limiter=new Transform({transform(chunk,encoding,callback){bytes+=chunk.length;callback(bytes>1024**3?fault('上传视频不能超过1GB，请改用关联本地路径。',413):null,chunk);}});
     await pipeline(req,limiter,createWriteStream(path,{flags:'wx'}));
    }else{
     const body=JSON.parse((await readBody(req)).toString());path=String(body.path||'').trim().replace(/^"|"$/g,'');
     if(!isAbsolute(path)||!extensions.has(extname(path).toLowerCase())||!existsSync(path)||!statSync(path).isFile())throw fault('请输入本机视频文件的完整路径。');
     path=realpathSync(path);
    }
    const metadata=await pythonJSON(config,appRoot,'driver-video.py',['probe',path]);
    const record={id:vid,projectId:p.id,name:uploaded?decodeURIComponent(req.headers['x-file-name']):basename(path),sourcePath:path,imported:uploaded,...fingerprint(path),metadata,createdAt:new Date().toISOString()};
    state.driverVideos.push(record);save();temporary=null;send(res,201,record);return true;
   }
   if(action!=='clips')throw fault('驱动操作无效。');
   const body=JSON.parse((await readBody(req)).toString());source(video);
   const start=Number(body.start??0),end=Number(body.end??Math.min(video.metadata.duration,start+3)),quality=body.quality??'native720';
   if(!['native720','preview'].includes(quality))throw fault('请选择原生高清或快速精修。');
   if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end>video.metadata.duration+.001)throw fault('片段起止时间无效。');
   const ranges=body.split?Array.from({length:Math.ceil((end-start)/3)},(_,i)=>[start+i*3,Math.min(end,start+(i+1)*3)]):[[start,end]];
   if(!body.split&&end-start>5.17)throw fault('单镜头最多5.17秒；完整视频请勾选按约3秒拆分。');
   if(p.shots.length+ranges.length>50)throw fault('拆分后镜头总数不能超过50。');
   const created=[];
   const ratio=video.metadata.width/video.metadata.height;
   if(p.production||!p.shots.length)p.production=normalizeProduction({...p.production,exportSize:Math.abs(ratio-.75)<.03?'720x960':Math.abs(ratio-4/3)<.03?'960x720':ratio===1?'768x768':ratio>1?'1280x720':'720x1280'},state.assets);
   for(const [a,b] of ranges){
    const cid=randomUUID(),folder=resolve(storage.projectFolder(p),'驱动素材',cid),output=resolve(folder,'depth.mp4');
    const uploadId=randomUUID(),imageName=`aigc-studio/drivers/${uploadId}.png`,preview=resolve(config.comfyRoot,'input',imageName);
    const metadata=await pythonJSON(config,appRoot,'driver-video.py',['prepare',source(video),output,preview,String(a),String(b)]);
    const file=relative(resolve(config.comfyRoot,'output'),output).split(sep).join('/');
    let width=metadata.width,height=metadata.height;
    if(quality==='native720'){
      const scale=768/Math.min(width,height);width=Math.round(width*scale/32)*32;height=Math.round(height*scale/32)*32;
      if(Math.max(width,height)>1536)throw fault('该画幅过长，请选择快速生成＋AI精修，或先裁剪视频。');
    }
    const c={id:cid,projectId:p.id,videoId:video.id,start:a,end:b,...metadata,controlWidth:metadata.width,controlHeight:metadata.height,width,height,quality,file,firstFrameUploadId:uploadId,fingerprint:createHash('sha256').update(JSON.stringify({video:video.id,bytes:video.bytes,mtime:video.mtime,a,b,...metadata,width,height,quality})).digest('hex')};
    const s={id:randomUUID(),title:`白膜 ${a.toFixed(2)}～${b.toFixed(2)}秒`,imagePrompt:'按白膜首帧的构图与人物姿态，使用所选角色和场景参考生成写实画面。',videoPrompt:'人物动作、身体位置与相机运动遵循深度驱动视频，保持首帧中的人物身份、服装与场景。',seed:'',referenceIds:[],characterIds:(p.characters||[]).map(r=>r.id),imageHistory:[],videoHistory:[],driver:c};
    state.uploads[uploadId]={name:imageName,type:'image/png'};state.driverClips.push(c);p.shots.push(s);created.push(s);save();
   }
   send(res,201,{shots:created});return true;
  }finally{active.delete(p.id);if(temporary&&existsSync(temporary))unlinkSync(temporary);}
 }
 return {handle,clip,busy:()=>active.size>0};
}
