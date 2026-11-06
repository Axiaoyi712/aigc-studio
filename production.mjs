import { createHash } from 'node:crypto';
import { characterContext } from './characters.mjs';
import { normalizeVideoOptions } from './public/video-options.js';
import { normalizeDirector, imageSize } from './public/director-options.js';
import { primaryOutput } from './media.mjs';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const join = parts => parts.filter(Boolean).join('\n');
const camera = {static:'The camera holds still.',push:'The camera pushes in slowly.',pull:'The camera pulls out slowly.',left:'The camera trucks left slowly.',right:'The camera trucks right slowly.',panLeft:'The camera pans left slowly.',panRight:'The camera pans right slowly.',follow:'The camera tracks the subject.',orbit:'The camera makes a small arc around the subject.'};
const frame = {wide:'远景，人物占比较小，交代环境。',full:'全景，人物从头到脚位于画面内。',medium:'中景，画面覆盖人物腰部以上。',close:'近景，画面覆盖人物胸口以上。',detail:'特写，以镜头明确指定的局部充满画面。'};
const angle = {eye:'相机与主体平视。',low:'相机位于主体下方，向上拍摄。',high:'相机位于主体上方，向下拍摄。',over:'从描述中前景人物肩后拍摄另一主体。',top:'相机从正上方向下拍摄。'};
function stateText(value){return Object.entries(value).filter(([,v])=>v).map(([k,v])=>`${k}: ${v}`).join('；');}
export function shotPlan(project, shot, assets) {
  const generalPrompt=String(shot.generalPrompt||'').trim();
  if(generalPrompt)shot={...shot,imagePrompt:'只生成视频开始时的一张静态首帧；动作过程作为理解背景，不画连续分镜、多宫格或动作叠影。\n综合描述：'+generalPrompt,videoPrompt:generalPrompt,director:undefined};
  const videoOptions=normalizeVideoOptions({...project.video,...(shot.frames?{frames:shot.frames}:{})});
  const role=characterContext(project,shot);
  const p=project.production||{};
  const d=normalizeDirector(shot.director);
  const referenceIds=[...new Set([...role.referenceIds,...(shot.inheritReferences===false?[]:p.referenceIds||[])])];
  const refs=referenceIds.map(id=>assets.find(a=>a.id===id));
  const common=join([p.style&&`画面风格：${p.style}`,p.palette&&`色调：${p.palette}`,p.lighting&&`光照：${p.lighting}`,(d.location||p.location)&&`地点与空间：${d.location||p.location}`,(d.time||p.time)&&`时间天气：${d.time||p.time}`,d.wardrobe&&`本镜头服装：${d.wardrobe}`]);
  const mapping=refs.map((a,i)=>`参考图 ${i+1}：${a?.name||'缺失素材'}；用途：${p.referenceNotes?.[a?.id]||({character:'人物身份与外观',scene:'场景结构',prop:'道具外观',style:'视觉风格'}[a?.category])||'按镜头描述使用'}。`).join('\n');
  const image=join([frame[d.framing],angle[d.angle],shot.imagePrompt,d.position&&`人物站位：${d.position}`,d.foreground&&`前景：${d.foreground}`,d.background&&`背景：${d.background}`,stateText(d.start)&&`起始状态：${stateText(d.start)}`,common,mapping,role.imagePrefix.replace(/镜头画面：$/,'')]);
  const visual=join([common,role.videoPrefix,frame[d.framing],angle[d.angle],d.position,d.foreground&&`前景：${d.foreground}`,d.background&&`背景：${d.background}`,stateText(d.start)&&`起始状态：${stateText(d.start)}`,shot.videoPrompt,d.action,camera[d.camera],d.dialogue&&`角色按原文说出：“${d.dialogue}”`,stateText(d.end)&&`结束状态：${stateText(d.end)}`]);
  const structured=Boolean(project.production||shot.director||generalPrompt);
  const audio=generalPrompt?{sound:'按综合描述中的声音要求生成；未写明时使用与画面相符的自然环境声。',music:'按综合描述中的配乐要求；未要求时不添加配乐。'}:{sound:d.sound||p.ambience,music:d.music};
  const instruction=project.videoTemplate==='h3-reference'?join([refs.map((a,i)=>`<Picture ${i+1}>：${a?.name}；用于${p.referenceNotes?.[a?.id]||'保持身份与外观'}。`).join('\n'),`<Picture ${refs.length+1}> 为已确认分镜图，用于构图、照明与风格参考，不强制作为首帧。`]):'For the target video, at 0.00 seconds, <Picture 1> is fully referenced.';
  let video=structured||project.videoTemplate==='h3-reference'?`${instruction}\n\nintegrated_multimodal_description: [Shot 1] ${visual}\n\noverall_soundscape: ${audio.sound||'与画面动作相符的自然环境声。'}\n\nnon_diegetic_music: ${audio.music||'N/A'}`:join([role.videoPrefix,shot.videoPrompt]);
  if(project.videoTemplate==='h3-reference'){
    const definitions=[...role.roles.map((r,i)=>`<Subject ${i+1}> is ${r.name}, ${r.identity||r.description}, referenced from ${r.referenceIds.map(id=>'<Picture '+(referenceIds.indexOf(id)+1)+'>').join(' and ')}.`)];
    for(const a of refs.filter(a=>a&&!role.roles.some(r=>r.referenceIds.includes(a.id))))definitions.push(`<Subject ${definitions.length+1}> is ${a.name} from <Picture ${referenceIds.indexOf(a.id)+1}>; reference role: ${p.referenceNotes?.[a.id]||a.category}.`);
    const layout=`<Picture ${refs.length+1}>`;
    video=`subject_definitions:\n${definitions.join('\n')}\n${layout} is the storyboard reference for [Shot 1], supplying composition and lighting rather than a mandatory first frame.\n\nsummary: [reference generation] A continuous shot following the referenced characters, scene, and storyboard composition.\n\nretention_analysis:\n${definitions.map((_,i)=>`<Subject ${i+1}> (appears in [Shot 1]): fully_preserved - retain the defined identity, appearance and reference role.`).join('\n')}\n${layout}: weak_reference - preserve shot planning and visual style.\n\ndetailed_description: The target video follows the visual style of ${layout}. [Shot 1] ${visual}\n\noverall_soundscape: ${audio.sound||'Natural ambience matching the scene.'}\n\nnon_diegetic_music: ${audio.music||'N/A'}`;
  }
  const visualSettings={style:p.style,palette:p.palette,lighting:p.lighting,location:d.location||p.location,time:d.time||p.time,wardrobe:d.wardrobe||undefined};
  const frameSignature=structured?hash({role:role.signature,refs:referenceIds,notes:p.referenceNotes,size:imageSize(project),visualSettings,imagePrompt:shot.imagePrompt,framing:d.framing,angle:d.angle,position:d.position,foreground:d.foreground,background:d.background,start:d.start}):null;
  const videoSignature=structured?hash({frameSignature,frameId:shot.confirmedFrameJobId,videoTemplate:project.videoTemplate,video:videoOptions,prompt:video}):null;
  const errors=[];const warnings=[];
  if(project.videoTemplate==='h3-reference'&&(videoOptions.frames>124||videoOptions.profile!=='draft'||videoOptions.aspect==='source'))errors.push('多参考实验路径仅支持约 3～5 秒、省显存档，并需明确画幅。');
  if(referenceIds.length>20)errors.push('角色、场景与道具参考合计超过 20 张，请减少参考或取消本镜头继承。');
  if(project.videoTemplate==='h3-reference'&&referenceIds.length>3)warnings.push('Ref2VA 实验视频仍限制 3 张资产参考加 1 张分镜图；首帧生成可使用最多 20 张。');
  if(refs.some(a=>!a))errors.push('存在已缺失的参考素材。');
  if(image.length>6000||video.length>6000)errors.push('合成提示词超过 6000 字，请精简。');
  if(!shot.imagePrompt?.trim())errors.push('请填写首帧画面描述。');
  if(!shot.videoPrompt?.trim()&&!d.action)errors.push('请填写镜头动作。');
  if(d.camera==='static'&&/跟随|推近|拉远|环绕/.test(shot.videoPrompt||''))warnings.push('固定机位与动作正文中的运镜可能冲突，请核对。');
  if(d.dialogue.length>videoOptions.frames/24*6)warnings.push('台词相对镜头时长较长，建议拆分或延长。');
  const previous=project.shots[project.shots.findIndex(s=>s.id===shot.id)-1];
  if(previous?.director)for(const key of ['holding','position','gaze','motion','light'])if(previous.director.end?.[key]&&d.start[key]&&previous.director.end[key]!==d.start[key])warnings.push(`与上一镜头的 ${({holding:'持物',position:'站位',gaze:'视线',motion:'运动',light:'光照'})[key]} 状态不同，请确认是有意变化。`);
  return {shotId:shot.id,promptMode:generalPrompt?'general':'detailed',imagePrompt:image,videoPrompt:video,video:videoOptions,referenceIds,refs:refs.filter(Boolean),size:imageSize(project),characterSignature:role.signature,frameSignature,videoSignature,errors,warnings};
}
export function frameMatches(project,shot,job,assets){const p=shotPlan(project,shot,assets);return Boolean(job?.status==='success'&&!job.deletedAt&&primaryOutput(job)?.kind==='image'&&(!p.characterSignature||job.characterSignature===p.characterSignature)&&(!p.frameSignature||job.frameSignature===p.frameSignature));}
export function videoMatches(project,shot,job,assets){const p=shotPlan(project,shot,assets);return Boolean(job?.status==='success'&&!job.deletedAt&&primaryOutput(job)?.kind==='video'&&job.frameJobId===shot.confirmedFrameJobId&&(!p.characterSignature||job.characterSignature===p.characterSignature)&&(!p.videoSignature||job.videoSignature===p.videoSignature));}
export function validateEdit(value={}, job) {
  const count=primaryOutput(job)?.metadata?.frame_count;
  const edit={jobId:job?.id||null,inFrame:Number(value.inFrame??0),outFrame:value.outFrame==null||value.outFrame===''?null:Number(value.outFrame),gain:Number(value.gain??1),mute:Boolean(value.mute),fade:Number(value.fade??0.08),notes:String(value.notes||'').slice(0,1000)};
  if(!Number.isInteger(edit.inFrame)||edit.inFrame<0||(edit.outFrame!==null&&(!Number.isInteger(edit.outFrame)||edit.outFrame<=edit.inFrame))||(count&&(edit.inFrame>=count||(edit.outFrame!==null&&edit.outFrame>count)))||!Number.isFinite(edit.gain)||edit.gain<0||edit.gain>2||!Number.isFinite(edit.fade)||edit.fade<0||edit.fade>1)throw Object.assign(Error('选段范围或音量无效：结束帧不包含在保留区间内。'),{status:400});
  return edit;
}
