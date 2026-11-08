const join=parts=>parts.filter(Boolean).join('\n');
const unique=parts=>[...new Set(parts.filter(Boolean).map(x=>x.trim()))];
const section=/^(想表达什么|镜头想表达什么|景别|机位|运镜|时长|人物站位与视线|动作与可见情绪|前后景、声音和连续性|出场角色|首帧画面描述|动作、镜头与声音|动作、镜头和声音)[：:]\s*/;
const cameraWords=/镜头|相机|机位|运镜|前推|推近|拉远|环绕|camera|push.?in|pan |zoom/i;
const cameras={static:'The camera holds still.',push:'The camera pushes in with small amplitude at slow speed.',pull:'The camera pulls out with small amplitude at slow speed.',left:'The camera trucks left slowly.',right:'The camera trucks right slowly.',panLeft:'The camera pans left slowly.',panRight:'The camera pans right slowly.',follow:'The camera tracks the subject.',orbit:'The camera makes a small arc around the subject.'};

function sections(text){
 const result={};let key;
 for(const line of text.split('\n')){const match=line.trim().match(section);if(match){key=match[1];result[key]=line.trim().slice(match[0].length);}else if(key)result[key]+='\n'+line;}
 return result;
}
function currentShot(text,adjustments){
 const clauses=text.split(/(?<=[。；;\n])/);
 const kept=clauses.filter(part=>!/(?:下一镜|下一场|下一段视频|承接镜头\s*\d|承接上一镜|上一镜结束后)/.test(part));
 if(kept.length!==clauses.length)adjustments.push('下一镜与跨镜头衔接说明仅保留在原文中，不送入本镜头。');
 return kept.join('').trim();
}
function removeExactSpeech(text,line){
 const escaped=line.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 return text.replace(new RegExp('(?:角色按原文说出|开口说台词|开口说|说台词|说出|说道|说|问道|问|台词)\\s*[：:]?\\s*[“「"]'+escaped+'[”」"]','g'),'').replace(new RegExp('[“「"]'+escaped+'[”」"]','g'),'');
}
export function shotEnvironment(project,director){
 const p=project.production||{},shared=p.environmentMode==='shared';
 const result={};for(const key of ['palette','lighting','location','time'])result[key]=director[key]||(shared?p[key]:'')||'';
 result.ambience=shared?p.ambience||'':'';return result;
}
export function compileShotPrompt(project,shot,director,roles=[]){
 const general=String(shot.generalPrompt||'').trim(),parts=sections(general),adjustments=[],warnings=[];
 const detailed=Boolean(shot.videoPrompt?.trim());
 let imageBody=general?(parts['首帧画面描述']||general):shot.imagePrompt||'';
 let body=general?(parts['动作、镜头与声音']||parts['动作、镜头和声音']||parts['动作与可见情绪']||general):detailed?shot.videoPrompt:director.action;
 const formatted=String(body||'').match(/integrated_multimodal_description:\s*(?:\[Shot 1\]\s*)?([\s\S]*?)\s*overall_soundscape:\s*([\s\S]*?)\s*non_diegetic_music:\s*([\s\S]*)$/);
 if(formatted){body=formatted[1];if(general&&!parts['首帧画面描述'])imageBody=body.replace(/<d>[\s\S]*?<\/d>/g,'');adjustments.push('已识别H3完整格式，直接使用正文与声音字段，不重复嵌套。');}
 if(general&&parts['首帧画面描述'])adjustments.push('总提示词中的首帧描述与视频动作已分开使用。');
 if(!general&&detailed&&director.action)adjustments.push('视频使用“动作、镜头与声音”正文，不再叠加左侧动作描述。');
 const raw=String(body||'');body=currentShot(raw,adjustments);imageBody=currentShot(imageBody,adjustments);
 // Plain dialogue and explicitly tagged H3 dialogue are normalized once, with original words retained.
 const tagged=[...body.matchAll(/<d>\s*\[([^\]]+)\]\s*([\s\S]*?)<\/d>/g)];
 const plain=[...body.matchAll(/(?:说台词|说出|说道|开口说|说|问道|问|台词)\s*[：:]?\s*[“「"]([^”」"]+)[”」"]/g)].map(m=>m[1]);
 const explicit=general?'':director.dialogue?.trim();
 const lines=unique([...tagged.map(m=>m[2]),...plain,explicit]);
 const taggedLanguage=new Map(tagged.map(m=>[m[2].trim(),m[1]]));
 const taggedSpeakers=new Map(tagged.map(m=>[m[2].trim(),Number(body.slice(0,m.index).match(/\(S(\d+)\)[^<]*$/)?.[1])||null]));
 const keptTags=new Set();body=body.replace(/<d>\s*\[([^\]]+)\]\s*([\s\S]*?)<\/d>/g,(all,lang,line)=>{const key=line.trim();if(keptTags.has(key))return '';keptTags.add(key);return all;});
 for(const line of unique([...plain,explicit]))body=removeExactSpeech(body,line);
 const speaker=roles.find(r=>r.id===director.speakerId)||roles[0];
 const voice=general?'':director.voice?.trim();
 const speakerNumber=Math.max(1,(project.characters||[]).findIndex(r=>r.id===speaker?.id)+1);
 const speechFor=line=>`${speaker?.name||'The on-screen character'} (S${taggedSpeakers.get(line)||speakerNumber})${voice?' ('+voice+')':''} says: <d>[${taggedLanguage.get(line)||'Chinese'}] ${line}</d>`;
 let speech=lines.filter(line=>!taggedLanguage.has(line)).map(speechFor);
 if(lines.length&&(plain.length+tagged.length+(explicit?1:0)>lines.length))adjustments.push('重复台词已合并，每句原文只提交一次。');
 if(lines.length>1&&!tagged.length)warnings.push('本镜头有多句台词，请检查说话人和时长；不同说话人建议分镜生成。');
 if(!body.trim()&&!speech.length)body='';
 let camera='';
 if(!general&&!cameraWords.test(body))camera=cameras[director.camera]||'';
 if(shot.motionMode==='steady'){
  speech=lines.map(speechFor);
  body='沿用已确认首帧的角色外观、服装、道具、身体姿态与两手位置。保持背景及光照稳定，仅有轻微眼神变化和自然呼吸'+(lines.length?'，嘴巴自然开合说话。':'，嘴唇自然闭合。');
  camera=cameras.static;adjustments.push('保稳模式：固定机位与手部，只保留微表情、呼吸及所选台词；原动作文字仍保留。');
 }else if(/卡通|玩偶|动物|蛙|机器人/.test([project.production?.style,...roles.map(r=>r.identity||r.description||r.name)].join(' '))&&/鼻翼|喉结|耳廓/.test(raw))warnings.push('卡通或非人角色包含鼻翼、喉结等动作，请核对首帧是否有对应部位；可切换保稳模式。');
 if(shot.motionMode!=='steady'&&(raw.match(/压向|撑住|锁紧|轻张|抬起|放下|转身|站起|抬高|抬起|抬下颌|微抬|端起|递给|拿起|走向|推近|前推/g)||[]).length>=5)warnings.push('本镜头动作较多，建议先用保稳模式验证，再逐步增加手部和运镜。');
 if(shot.motionMode!=='steady'&&/前推约半米|前推半米|推进半米/.test(raw)&&director.framing==='close')warnings.push('近景推进半米可能明显改变取景，建议先固定机位或使用小幅缓慢推近。');
 const environment=shotEnvironment(project,director);
 if((project.production?.environmentMode||'shot')==='shot'&&['palette','lighting','location','time','ambience'].some(k=>project.production?.[k]))adjustments.push('全片环境资料未注入；本镜头只采用单独填写的环境与首帧。');
 const sound=shot.motionMode==='steady'?'与当前画面相符的轻微自然环境声，不额外添加电流嘶声。':formatted?.[2]|| (general?'与当前画面相符的轻微自然环境声。':director.sound||environment.ambience||'与当前画面相符的轻微自然环境声。');
 const music=shot.motionMode==='steady'?'N/A':formatted?.[3]||(general?(/无配乐|没有配乐/.test(general)?'N/A':'按本镜头正文要求；未要求时不添加配乐。'):director.music||'N/A');
 return {imageBody,body:join([body.trim(),camera,...speech]),sound,music,environment,adjustments:unique(adjustments),warnings:unique(warnings),hasAction:Boolean(raw.trim()||speech.length||shot.motionMode==='steady'),general:Boolean(general)};
}
