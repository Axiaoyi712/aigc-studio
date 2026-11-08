import { createHash } from 'node:crypto';
import { characterContext } from './characters.mjs';
import { normalizeVideoOptions } from './public/video-options.js';
import { normalizeDirector, imageSize } from './public/director-options.js';
import { primaryOutput } from './media.mjs';
import {compileShotPrompt} from './prompt-compiler.mjs';
import {videoSpecification} from './public/video-options.js';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const join = parts => parts.filter(Boolean).join('\n');
const frame = {wide:'远景，人物占比较小，交代环境。',full:'全景，人物从头到脚位于画面内。',medium:'中景，画面覆盖人物腰部以上。',close:'近景，画面覆盖人物胸口以上。',detail:'特写，以镜头明确指定的局部充满画面。'};
const angle = {eye:'相机与主体平视。',low:'相机位于主体下方，向上拍摄。',high:'相机位于主体上方，向下拍摄。',over:'从描述中前景人物肩后拍摄另一主体。',top:'相机从正上方向下拍摄。'};
function stateText(value){return Object.entries(value).filter(([,v])=>v).map(([k,v])=>`${k}: ${v}`).join('；');}
export function shotPlan(project, shot, assets) {
  if(shot.videoTemplate)project={...project,videoTemplate:shot.videoTemplate};
  const generalPrompt=String(shot.generalPrompt||'').trim();
  const videoOptions=normalizeVideoOptions({...project.video,...(shot.frames?{frames:shot.frames}:{})});
  const role=characterContext(project,generalPrompt?{...shot,director:undefined}:shot);
  const p=project.production||{};
  const originalDirector=normalizeDirector(shot.director);
  const compiled=compileShotPrompt(project,shot,originalDirector,role.roles);
  const d=generalPrompt?normalizeDirector(Object.fromEntries(['palette','lighting','location','time'].map(key=>[key,originalDirector[key]]))):originalDirector;
  const imageDescription=generalPrompt?'只生成视频开始时的一张静态首帧；动作过程作为理解背景，不画连续分镜、多宫格或动作叠影。\n综合描述：'+compiled.imageBody:compiled.imageBody;
  const referenceIds=[...new Set([...role.referenceIds,...(shot.inheritReferences===false?[]:p.referenceIds||[])])];
  const refs=referenceIds.map(id=>assets.find(a=>a.id===id));
  const env=compiled.environment;
  const common=join([p.style&&`画面风格：${p.style}`,env.palette&&`色调：${env.palette}`,env.lighting&&`光照：${env.lighting}`,env.location&&`地点与空间：${env.location}`,env.time&&`时间天气：${env.time}`,d.wardrobe&&`本镜头服装：${d.wardrobe}`]);
  const mapping=refs.map((a,i)=>`参考图 ${i+1}：${a?.name||'缺失素材'}；用途：${p.referenceNotes?.[a?.id]||({character:'人物身份与外观',scene:'场景结构',prop:'道具外观',style:'视觉风格'}[a?.category])||'按镜头描述使用'}。`).join('\n');
  const image=join([frame[d.framing],angle[d.angle],imageDescription,d.position&&`人物站位：${d.position}`,d.foreground&&`前景：${d.foreground}`,d.background&&`背景：${d.background}`,stateText(d.start)&&`起始状态：${stateText(d.start)}`,common,mapping,role.imagePrefix.replace(/镜头画面：$/,'')]);
  const visual=join([common,project.videoTemplate==='h3-reference'?join([role.videoPrefix,frame[d.framing],angle[d.angle],d.position,d.foreground,d.background]):join([role.roles.length?'首帧角色标识：'+role.roles.map(r=>r.name).join('、')+'。':'','沿用已确认首帧的角色外观、服装、体型、道具及构图，动作从该画面连续发展。']),compiled.body,stateText(d.end)&&`结束状态：${stateText(d.end)}`]);
  const structured=Boolean(project.production||shot.director||generalPrompt);
  const audio={sound:compiled.sound,music:compiled.music};
  const instruction=project.videoTemplate==='h3-reference'?join([refs.map((a,i)=>`<Picture ${i+1}>：${a?.name}；用于${p.referenceNotes?.[a?.id]||'保持身份与外观'}。`).join('\n'),`<Picture ${refs.length+1}> 为已确认分镜图，用于构图、照明与风格参考，不强制作为首帧。`]):'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.';
  let video=`${instruction}\n\nintegrated_multimodal_description: [Shot 1] ${visual}\n\noverall_soundscape: ${audio.sound}\n\nnon_diegetic_music: ${audio.music}`;
  if(project.videoTemplate==='h3-reference'){
    const definitions=[...role.roles.map((r,i)=>`<Subject ${i+1}> is ${r.name}, ${r.identity||r.description}, referenced from ${r.referenceIds.map(id=>'<Picture '+(referenceIds.indexOf(id)+1)+'>').join(' and ')}.`)];
    for(const a of refs.filter(a=>a&&!role.roles.some(r=>r.referenceIds.includes(a.id))))definitions.push(`<Subject ${definitions.length+1}> is ${a.name} from <Picture ${referenceIds.indexOf(a.id)+1}>; reference role: ${p.referenceNotes?.[a.id]||a.category}.`);
    const layout=`<Picture ${refs.length+1}>`;
    video=`subject_definitions:\n${definitions.join('\n')}\n${layout} is the storyboard reference for [Shot 1], supplying composition and lighting rather than a mandatory first frame.\n\nsummary: [reference generation] A continuous shot following the referenced characters, scene, and storyboard composition.\n\nretention_analysis:\n${definitions.map((_,i)=>`<Subject ${i+1}> (appears in [Shot 1]): fully_preserved - retain the defined identity, appearance and reference role.`).join('\n')}\n${layout}: weak_reference - preserve shot planning and visual style.\n\ndetailed_description: The target video follows the visual style of ${layout}. [Shot 1] ${visual}\n\noverall_soundscape: ${audio.sound||'Natural ambience matching the scene.'}\n\nnon_diegetic_music: ${audio.music||'N/A'}`;
  }
  const visualSettings={style:p.style,palette:env.palette||undefined,lighting:env.lighting||undefined,location:env.location||undefined,time:env.time||undefined,wardrobe:d.wardrobe||undefined};
  const referenceVersions=refs.filter(a=>a?.contentVersion).map(a=>[a.id,a.contentVersion]);
  const frameSignature=structured?hash({role:role.signature,refs:referenceIds,...(referenceVersions.length?{referenceVersions}:{}),notes:p.referenceNotes,size:imageSize(project),visualSettings,imagePrompt:imageDescription,framing:d.framing,angle:d.angle,position:d.position,foreground:d.foreground,background:d.background,start:d.start}):null;
  const manual=shot.frameApproval?.jobId===shot.confirmedFrameJobId&&Boolean(shot.frameApproval?.sha256);
  const videoSignature=manual?hash({externalFrameHash:shot.frameApproval.sha256,frameId:shot.confirmedFrameJobId,videoTemplate:project.videoTemplate,video:videoOptions,prompt:video}):structured?hash({frameSignature,frameId:shot.confirmedFrameJobId,videoTemplate:project.videoTemplate,video:videoOptions,prompt:video}):null;
  const imageErrors=[],videoErrors=[],warnings=[...compiled.warnings];
  if(project.videoTemplate==='h3-reference'&&(videoOptions.frames>124||videoOptions.profile!=='draft'||videoOptions.aspect==='source'))videoErrors.push('多参考实验路径仅支持约 3～5 秒、省显存档，并需明确画幅。');
  if(referenceIds.length>20)imageErrors.push('角色、场景与道具参考合计超过 20 张，请减少参考或取消本镜头继承。');
  if(project.videoTemplate==='h3-reference'&&referenceIds.length>3)warnings.push('Ref2VA 实验视频仍限制 3 张资产参考加 1 张分镜图；首帧生成可使用最多 20 张。');
  if(refs.some(a=>!a))imageErrors.push('存在已缺失的参考素材。');
  if(project.videoTemplate==='h3-reference')videoErrors.push(...imageErrors);
  if(image.length>6000)imageErrors.push('首帧合成提示词超过 6000 字，请精简。');
  if(video.length>6000)videoErrors.push('视频合成提示词超过 6000 字，请精简。');
  if(!imageDescription.trim())imageErrors.push('请填写首帧画面描述。');
  if(!compiled.hasAction)videoErrors.push('请填写镜头动作。');
  if(videoOptions.frames<124)warnings.push('约 3 秒为实验短片；当前 H3 节点主要训练时长约 5～15 秒，建议先用 5.17 秒验证口型与动作。');
  const errors=[...new Set(manual?videoErrors:[...imageErrors,...videoErrors])];
  if(shot.motionMode!=='steady'&&d.camera==='static'&&/跟随|推近|拉远|环绕/.test(shot.videoPrompt||''))warnings.push('固定机位与动作正文中的运镜可能冲突；正文优先，请核对。');
  if(d.dialogue.length>videoOptions.frames/24*6)warnings.push('台词相对镜头时长较长，建议拆分或延长。');
  const previous=project.shots[project.shots.findIndex(s=>s.id===shot.id)-1];
  if(previous?.director)for(const key of ['holding','position','gaze','motion','light'])if(previous.director.end?.[key]&&d.start[key]&&previous.director.end[key]!==d.start[key])warnings.push(`与上一镜头的 ${({holding:'持物',position:'站位',gaze:'视线',motion:'运动',light:'光照'})[key]} 状态不同，请确认是有意变化。`);
  return {compilerVersion:2,shotId:shot.id,videoTemplate:project.videoTemplate,promptMode:generalPrompt?'general':'detailed',motionMode:shot.motionMode||'described',environmentMode:p.environmentMode||'shot',environment:env,adjustments:compiled.adjustments,specification:videoSpecification(videoOptions),imagePrompt:image,videoPrompt:video,video:videoOptions,referenceIds,refs:refs.filter(Boolean),size:imageSize(project),characterSignature:role.signature,frameSignature,videoSignature,errors,imageErrors,videoErrors,warnings};
}
export function frameMatches(project,shot,job,assets){const p=shotPlan(project,shot,assets),file=primaryOutput(job);if(job?.source==='external')return Boolean(job.status==='success'&&!job.deletedAt&&!job.externalFrame?.invalid&&file?.kind==='image'&&shot.confirmedFrameJobId===job.id&&shot.frameApproval?.jobId===job.id&&shot.frameApproval.sha256===file.sha256);return Boolean(job?.status==='success'&&!job.deletedAt&&file?.kind==='image'&&(!p.characterSignature||job.characterSignature===p.characterSignature)&&(!p.frameSignature||job.frameSignature===p.frameSignature));}
export function videoMatches(project,shot,job,assets){const p=shotPlan(project,shot,assets),manual=shot.frameApproval?.jobId===shot.confirmedFrameJobId&&shot.frameApproval?.sha256;return Boolean(job?.status==='success'&&!job.deletedAt&&primaryOutput(job)?.kind==='video'&&job.frameJobId===shot.confirmedFrameJobId&&(manual?job.externalFrameHash===manual:!p.characterSignature||job.characterSignature===p.characterSignature)&&(!p.videoSignature||job.videoSignature===p.videoSignature));}
export function validateEdit(value={}, job) {
  const count=primaryOutput(job)?.metadata?.frame_count;
  const edit={jobId:job?.id||null,inFrame:Number(value.inFrame??0),outFrame:value.outFrame==null||value.outFrame===''?null:Number(value.outFrame),gain:Number(value.gain??1),mute:Boolean(value.mute),fade:Number(value.fade??0.08),notes:String(value.notes||'').slice(0,1000)};
  if(!Number.isInteger(edit.inFrame)||edit.inFrame<0||(edit.outFrame!==null&&(!Number.isInteger(edit.outFrame)||edit.outFrame<=edit.inFrame))||(count&&(edit.inFrame>=count||(edit.outFrame!==null&&edit.outFrame>count)))||!Number.isFinite(edit.gain)||edit.gain<0||edit.gain>2||!Number.isFinite(edit.fade)||edit.fade<0||edit.fade>1)throw Object.assign(Error('选段范围或音量无效：结束帧不包含在保留区间内。'),{status:400});
  return edit;
}
