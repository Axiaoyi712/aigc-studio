import {randomUUID} from 'node:crypto';
import {uploadPath} from './uploads.mjs';
import {primaryOutput,requireMedia} from './media.mjs';
const categories=['character','scene','prop','style'];
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const refs=p=>new Set([...(p.production?.referenceIds||[]),...(p.characters||[]).flatMap(r=>r.referenceIds||[]),...(p.shots||[]).flatMap(s=>s.referenceIds||[])]);
export const projectAssets=(state,p)=>(state.assets||[]).filter(a=>(p.catalog||[]).some(g=>g.assetIds.includes(a.id)));
export function migrateCatalog(state){
 state.projects??=[];state.assets??=[];
 if(state.assetCatalogVersion===1)return;
 for(const a of state.assets){const owners=state.projects.filter(p=>refs(p).has(a.id));a.scope=owners.length===1?'project':owners.length?'shared':'unassigned';a.ownerProjectId=owners.length===1?owners[0].id:null;a.groupId??=a.id;a.groupName??=a.name;a.view??='参考';}
 for(const p of state.projects){
  const used=refs(p);p.catalog=[];
  for(const r of p.characters||[]){const images=state.assets.filter(a=>r.referenceIds.includes(a.id));if(!images.length)continue;const gid=images.find(a=>a.groupId!==a.id)?.groupId||r.id;for(const a of images){a.groupId=gid;a.groupName=r.name;}r.groupId=gid;}
  for(const a of state.assets.filter(a=>used.has(a.id))){let g=p.catalog.find(g=>g.id===a.groupId);if(!g){const r=(p.characters||[]).find(r=>r.groupId===a.groupId);g={id:a.groupId,name:r?.name||a.name,category:a.category,assetIds:[],defaultReferenceIds:r?[...r.referenceIds]:[a.id]};p.catalog.push(g);}g.assetIds.push(a.id);}
 }
 state.assetCatalogVersion=1;
}
export function pruneCatalog(state){
 const valid=new Set(state.assets.map(a=>a.id));
 for(const p of state.projects){for(const g of p.catalog||[]){g.assetIds=g.assetIds.filter(id=>valid.has(id));g.defaultReferenceIds=g.defaultReferenceIds.filter(id=>g.assetIds.includes(id));}p.catalog=(p.catalog||[]).filter(g=>g.assetIds.length);const missing=new Set((p.characters||[]).filter(r=>!r.referenceIds.length).map(r=>r.id));p.characters=(p.characters||[]).filter(r=>!missing.has(r.id));for(const s of p.shots||[])if(s.characterIds)s.characterIds=s.characterIds.filter(id=>!missing.has(id));}
}
export function createAssetCatalog({state,save,send,readBody,config,lifecycle,isBusy}){
 migrateCatalog(state);
 const project=id=>state.projects.find(p=>p.id===id)||fail('项目不存在。',404);
 const ids=(value,all)=>{if(!Array.isArray(value)||!value.length||new Set(value).size!==value.length||value.some(id=>!all.some(a=>a.id===id)))fail('请选择有效且不重复的素材。');return value;};
 const idle=()=>{if(isBusy())fail('请等待生成、排队或导出完成，再调整素材。',409);};
 function groups(p){return (p.catalog||[]).map(g=>({...g,assets:g.assetIds.map(id=>state.assets.find(a=>a.id===id)).filter(Boolean)}));}
 function library(){const out=[];for(const a of state.assets){let g=out.find(g=>g.id===a.groupId);if(!g){g={id:a.groupId,name:a.groupName||a.name,category:a.category,scope:a.scope,ownerProjectId:a.ownerProjectId,source:state.projects.find(p=>p.id===a.ownerProjectId)?.name||(a.scope==='shared'?'公共素材':'待分类'),assets:[]};out.push(g);}g.assets.push(a);}return out;}
 function attach(p,assets){
  p.catalog??=[];
  for(const a of assets){if(a.scope==='unassigned'){a.scope='project';a.ownerProjectId=p.id;}else if(a.ownerProjectId&&a.ownerProjectId!==p.id){a.scope='shared';a.ownerProjectId=null;}
   let g=p.catalog.find(g=>g.id===a.groupId);if(!g){g={id:a.groupId,name:a.groupName||a.name,category:a.category,assetIds:[],defaultReferenceIds:[]};p.catalog.push(g);}if(!g.assetIds.includes(a.id))g.assetIds.push(a.id);if(!g.defaultReferenceIds.length)g.defaultReferenceIds=[a.id];
  }
 }
 function role(p,g){return (p.characters||[]).find(r=>r.groupId===g.id);}
 function bindRole(p,g){
  if(g.category!=='character')return;
  p.characters??=[];let r=role(p,g);if(!r){for(const s of p.shots||[])s.characterIds??=p.characters.map(r=>r.id);r={id:randomUUID(),groupId:g.id,name:g.name,description:'',referenceIds:[]};p.characters.push(r);}r.name=g.name;r.referenceIds=[...g.defaultReferenceIds];
 }
 function removeFromProject(p,removed){
  const set=new Set(removed);for(const g of p.catalog||[]){g.assetIds=g.assetIds.filter(id=>!set.has(id));g.defaultReferenceIds=g.defaultReferenceIds.filter(id=>!set.has(id));}
  if(p.production){p.production.referenceIds=(p.production.referenceIds||[]).filter(id=>!set.has(id));for(const id of set)delete p.production.referenceNotes?.[id];}
  for(const r of p.characters||[])r.referenceIds=r.referenceIds.filter(id=>!set.has(id));for(const s of p.shots||[])s.referenceIds=(s.referenceIds||[]).filter(id=>!set.has(id));pruneCatalog(state);
 }
 function usage(a){return state.projects.filter(p=>projectAssets(state,p).some(x=>x.id===a.id)).map(p=>({id:p.id,name:p.name,roles:(p.characters||[]).filter(r=>r.referenceIds.includes(a.id)).map(r=>r.name),shots:(p.shots||[]).filter(s=>s.referenceIds?.includes(a.id)||(p.production?.referenceIds||[]).includes(a.id)&&s.inheritReferences!==false||(p.characters||[]).some(r=>r.referenceIds.includes(a.id)&&(!s.characterIds||s.characterIds.includes(r.id)))).map(s=>s.title)}));}
 function addAsset(body){
  const p=body.projectId?project(body.projectId):null;
  if(!state.uploads[body.uploadId])fail('素材图片不存在。');if(!categories.includes(body.category))fail('请选择素材分类。');const name=String(body.name||'').trim();if(!name||name.length>80)fail('素材名称为1～80字。');
  const g=body.groupId?p?.catalog?.find(g=>g.id===body.groupId&&g.category===body.category):null;if(body.groupId&&!g)fail('素材组不存在或分类不同。');
  const a={id:randomUUID(),name,category:body.category,uploadId:body.uploadId,scope:p?'project':'unassigned',ownerProjectId:p?.id||null,groupId:g?.id||randomUUID(),groupName:g?.name||name,view:String(body.view||'参考').slice(0,40)};state.assets.push(a);if(p){attach(p,[a]);bindRole(p,p.catalog.find(g=>g.id===a.groupId));}save();return a;
 }
 async function handle(req,res,url){
  const detail=url.pathname.match(/^\/api\/assets\/([a-f0-9-]+)\/details$/);
  if(detail&&req.method==='GET'){const a=state.assets.find(a=>a.id===detail[1])||fail('素材不存在。',404),path=uploadPath(config,state.uploads[a.uploadId]);let exists=true;try{requireMedia(config,state.uploads[a.uploadId]?.file);}catch{exists=false;}send(res,200,{asset:a,path,exists,usage:usage(a)});return true;}
  if(!url.pathname.startsWith('/api/catalog'))return false;
  if(req.method==='GET'&&url.pathname==='/api/catalog'){send(res,200,library());return true;}
  if(req.method!=='POST')fail('接口不存在。',404);idle();const body=JSON.parse((await readBody(req)).toString('utf8'));
  if(url.pathname==='/api/catalog/delete'){const selected=ids(body.assetIds,state.assets).map(id=>state.assets.find(a=>a.id===id)),result=lifecycle.detach(selected.map(a=>uploadPath(config,state.uploads[a.uploadId])));pruneCatalog(state);save();send(res,200,result);return true;}
  const m=url.pathname.match(/^\/api\/catalog\/([a-f0-9-]+)\/(import|remove|groups)(?:\/([a-f0-9-]+))?$/);if(!m)fail('接口不存在。',404);const p=project(m[1]);
  if(m[2]==='import'){
   let selected=[];
   if(body.jobIds){const jobs=ids(body.jobIds,state.jobs);if(!categories.includes(body.category)||!String(body.name||'').trim())fail('请选择分类并填写素材名称。');for(const id of jobs){const j=state.jobs.find(j=>j.id===id),f=primaryOutput(j);if(j.deletedAt||j.status!=='success'||f?.kind!=='image')fail('请选择已完成的图片作品。');requireMedia(config,f);}const gid=randomUUID();for(const id of jobs){const j=state.jobs.find(j=>j.id===id),f=primaryOutput(j);let pair=Object.entries(state.uploads).find(([id,u])=>u.file?.filename===f.filename&&u.file?.subfolder===f.subfolder&&u.file?.type===f.type);if(!pair){pair=[randomUUID(),{file:{...f},sourceJobId:id,type:'image/png'}];state.uploads[pair[0]]=pair[1];}const existing=state.assets.find(a=>a.uploadId===pair[0]);if(existing){selected.push(existing);continue;}const a={id:randomUUID(),name:String(body.name).slice(0,80),category:body.category,uploadId:pair[0],scope:'project',ownerProjectId:p.id,groupId:gid,groupName:String(body.name).slice(0,80),view:'作品参考'};state.assets.push(a);selected.push(a);}}
   else{if(body.groupIds&&(!Array.isArray(body.groupIds)||!body.groupIds.length||new Set(body.groupIds).size!==body.groupIds.length))fail('素材组已变化，请重新选择。');const all=body.groupIds?library().filter(g=>body.groupIds.includes(g.id)).flatMap(g=>g.assets):null;if(body.groupIds&&new Set(all.map(a=>a.groupId)).size!==body.groupIds.length)fail('素材组已变化，请重新选择。');selected=all||ids(body.assetIds,state.assets).map(id=>state.assets.find(a=>a.id===id));}
   attach(p,selected);for(const g of p.catalog)if(selected.some(a=>g.assetIds.includes(a.id)))bindRole(p,g);
  }else if(m[2]==='remove'){
   const selected=ids(body.assetIds,projectAssets(state,p));removeFromProject(p,selected);
   for(const a of state.assets.filter(a=>selected.includes(a.id)&&a.ownerProjectId===p.id)){a.ownerProjectId=null;a.scope='unassigned';}
  }else if(m[3]){
   const g=p.catalog.find(g=>g.id===m[3])||fail('素材组不存在。',404);const name=String(body.name||'').trim();if(!name||name.length>80)fail('名称为1～80字。');const defaults=ids(body.defaultReferenceIds,g.assetIds.map(id=>({id})));if(defaults.length>20)fail('默认参考最多20张。');
   for(const key of ['description','identity','wardrobe'])if(String(body[key]||'').length>(key==='description'?1600:800))fail('人物设定过长。');
   g.name=name;g.defaultReferenceIds=defaults;for(const a of state.assets.filter(a=>g.assetIds.includes(a.id))){if(a.ownerProjectId===p.id){a.name=name;a.groupName=name;}if(body.views?.[a.id]!==undefined)a.view=String(body.views[a.id]).slice(0,40);}
   bindRole(p,g);const r=role(p,g);if(r)for(const key of ['description','identity','wardrobe'])r[key]=String(body[key]||'').trim();
  }else{
   const selected=ids(body.assetIds,projectAssets(state,p)).map(id=>state.assets.find(a=>a.id===id));const category=selected[0].category;if(selected.some(a=>a.category!==category))fail('只能合并同一分类的素材。');const name=String(body.name||'').trim();if(!name||name.length>80)fail('请填写素材组名称。');
   const selectedSet=new Set(selected.map(a=>a.id)),oldRoles=(p.characters||[]).filter(r=>r.referenceIds.some(id=>selectedSet.has(id))),first=oldRoles[0],gid=randomUUID();
   if(p.catalog.some(g=>g.assetIds.some(id=>selectedSet.has(id))&&g.assetIds.some(id=>!selectedSet.has(id))))fail('请选中完整素材组后合并。');
   for(const g of p.catalog){g.assetIds=g.assetIds.filter(id=>!selectedSet.has(id));g.defaultReferenceIds=g.defaultReferenceIds.filter(id=>!selectedSet.has(id));}p.catalog=p.catalog.filter(g=>g.assetIds.length);
   const g={id:gid,name,category,assetIds:selected.map(a=>a.id),defaultReferenceIds:first?first.referenceIds.filter(id=>selectedSet.has(id)):[selected[0].id]};p.catalog.push(g);
   for(const a of selected)if(a.ownerProjectId===p.id){a.groupId=gid;a.groupName=name;}
   if(category==='character'){
    const wholeRoles=oldRoles.filter(r=>r.referenceIds.every(id=>selectedSet.has(id)));if(first&&wholeRoles.includes(first)){first.groupId=gid;first.name=name;first.referenceIds=g.defaultReferenceIds;const removed=new Set(wholeRoles.slice(1).map(r=>r.id));p.characters=p.characters.filter(r=>!removed.has(r.id));for(const s of p.shots||[])if(s.characterIds)s.characterIds=[...new Set(s.characterIds.map(id=>removed.has(id)?first.id:id))];}else bindRole(p,g);
   }
  }
  save();send(res,200,{project:p,groups:groups(p)});return true;
 }
 return {handle,addAsset,groups,usage};
}
