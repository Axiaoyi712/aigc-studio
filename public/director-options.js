export const framing = {custom:'按描述',wide:'远景：环境为主',full:'全景：人物全身',medium:'中景：腰部以上',close:'近景：胸口以上',detail:'特写：指定局部'};
export const angles = {custom:'按描述',eye:'平视',low:'仰拍',high:'俯拍',over:'越肩视角',top:'正上方俯视'};
export const cameraMoves = {custom:'按描述',static:'固定机位',push:'缓慢推近',pull:'缓慢拉远',left:'向左平移',right:'向右平移',panLeft:'向左摇镜',panRight:'向右摇镜',follow:'跟随',orbit:'轻微环绕'};
export const directorText = {intent:'镜头表达什么',position:'人物站位与视线',foreground:'前景',background:'背景',action:'动作与可见情绪',dialogue:'台词原文（只填写一次）',voice:'说话声音，例如低沉男声',speakerId:'说话角色',sound:'本镜头环境与动作声音',music:'本镜头音乐要求',palette:'本镜头色调',lighting:'本镜头光照',location:'本镜头地点与空间',time:'本镜头时间天气',wardrobe:'本镜头服装（留空保持定稿）'};
export const stateFields = {position:'场景中位置',holding:'持物与道具状态',gaze:'视线',motion:'运动方向',light:'主光方向'};
const words = value => String(value ?? '').trim();
export function normalizeDirector(value = {}) {
  const result = {};
  for (const key of Object.keys(directorText)) { result[key] = words(value[key]); if(result[key].length>1200) throw Error('单项分镜描述不超过 1200 字。'); }
  for(const [key,choices] of [['framing',framing],['angle',angles],['camera',cameraMoves]]){result[key]=value[key]??'custom';if(!Object.hasOwn(choices,result[key]))throw Error('分镜选项无效。');}
  for(const key of ['start','end']) { result[key]={}; for(const field of Object.keys(stateFields)){result[key][field]=words(value[key]?.[field]);if(result[key][field].length>300)throw Error('连续性状态不超过 300 字。');} }
  return result;
}
export function normalizeProduction(value = {}, assets = []) {
  const result = {};
  for(const key of ['story','style','palette','lighting','location','time','ambience']){result[key]=words(value[key]);if(result[key].length>1200)throw Error('项目设定单项不超过 1200 字。');}
  result.environmentMode=value.environmentMode??'shot';
  if(!['shot','shared'].includes(result.environmentMode))throw Error('请选择按镜头设置环境，或全片同一环境。');
  result.frameQuality=value.frameQuality??'standard';
  result.frameAspect=value.frameAspect??'video';
  result.exportSize=value.exportSize??'1280x720';
  if(!['preview','standard','high'].includes(result.frameQuality)||!['video','square','landscape','portrait'].includes(result.frameAspect)||!['1280x720','720x1280','768x768','1920x1080','1080x1920'].includes(result.exportSize))throw Error('项目画幅或质量无效。');
  result.referenceIds=value.referenceIds??[];
  if(!Array.isArray(result.referenceIds)||new Set(result.referenceIds).size!==result.referenceIds.length||result.referenceIds.some(id=>!assets.some(asset=>asset.id===id)))throw Error('项目参考素材无效。');
  result.referenceNotes={};
  for(const id of result.referenceIds){result.referenceNotes[id]=words(value.referenceNotes?.[id]).slice(0,300);}
  result.backgroundAudioId=value.backgroundAudioId||null;
  result.backgroundGain=Number(value.backgroundGain??0.2);
  if(!Number.isFinite(result.backgroundGain)||result.backgroundGain<0||result.backgroundGain>2)throw Error('背景音量应为 0～2。');
  return result;
}
export function imageSize(project) {
  if(!project.production)return '512x512';
  const p=project.production;
  const aspect=p.frameAspect==='video' ? (project.video?.aspect==='source'?'square':project.video?.aspect||'square') : p.frameAspect;
  const sizes={preview:{square:'512x512',landscape:'768x432',portrait:'432x768'},standard:{square:'768x768',landscape:'1024x576',portrait:'576x1024'},high:{square:'1024x1024',landscape:'1280x720',portrait:'720x1280'}};
  return sizes[p.frameQuality][aspect];
}
