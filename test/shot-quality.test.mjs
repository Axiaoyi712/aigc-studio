import test from 'node:test';
import assert from 'node:assert/strict';
import {shotPlan,frameMatches,videoMatches} from '../production.mjs';
import {normalizeProduction,normalizeDirector} from '../public/director-options.js';
import {normalizeVideoOptions,videoSpecification} from '../public/video-options.js';
import {loadGraph,compileGraph,parseRequest} from '../workflows.mjs';
import {fileURLToPath} from 'node:url';
const count=(text,value)=>text.split(value).length-1;
function scene(){
 const shot={id:'shot',imagePrompt:'黄色玩偶在办公室接电话。',videoPrompt:'固定机位，玩偶说台词：「喂，你现在方便接电话吗？」。下一镜硬切到浴室，通话继续。',referenceIds:[],director:normalizeDirector({action:'旧动作，翻过桌子。',dialogue:'喂，你现在方便接电话吗？',voice:'低沉男声',location:'白天办公室',camera:'static'}),confirmedFrameJobId:'image'};
 const project={shots:[shot],characters:[{id:'actor',name:'玩偶',identity:'黄色圆头玩偶',referenceIds:[]}],videoTemplate:'h3-fast',video:{frames:124,profile:'high',aspect:'portrait'},production:normalizeProduction({style:'3D卡通',location:'办公室、浴室、街道、隧道',palette:'浴室金色、雨夜冷蓝',lighting:'夜雨灯光',time:'后半段转夜雨',ambience:'雨声和隧道滴水'})};
 return {project,shot};
}
test('one office shot excludes whole-film environments and next-shot directions without changing source data',()=>{
 const {project,shot}=scene(),before=JSON.stringify({project,shot}),plan=shotPlan(project,shot,[]);
 assert.match(plan.videoPrompt,/白天办公室/);assert.doesNotMatch(plan.videoPrompt,/浴室|街道|隧道|夜雨|翻过桌子|下一镜/);assert.equal(JSON.stringify({project,shot}),before);assert.match(plan.adjustments.join(''),/全片环境资料未注入/);
});
test('single-location projects can opt into shared environment and per-shot overrides also work in general mode',()=>{
 const {project,shot}=scene();project.production.environmentMode='shared';project.production.location='书房';project.production.lighting='暖色台灯';shot.director.location='';
 assert.match(shotPlan(project,shot,[]).videoPrompt,/书房|暖色台灯/);
 shot.generalPrompt='只做轻微转头。';shot.director.location='阳台';shot.director.lighting='午后自然光';const plan=shotPlan(project,shot,[]);assert.match(plan.videoPrompt,/阳台/);assert.match(plan.videoPrompt,/午后自然光/);assert.doesNotMatch(plan.videoPrompt,/书房|暖色台灯|翻过桌子/);
});
test('one authoritative action and canonical speech prevent duplicate dialogue while preserving original words',()=>{
 const {project,shot}=scene(),plan=shotPlan(project,shot,[]);assert.equal(count(plan.videoPrompt,'喂，你现在方便接电话吗？'),1);assert.equal(count(plan.videoPrompt,'<d>'),1);assert.match(plan.videoPrompt,/玩偶 \(S1\).*低沉男声.*<d>\[Chinese\] 喂，你现在方便接电话吗？<\/d>/);assert.match(plan.adjustments.join(''),/重复台词已合并/);assert.doesNotMatch(plan.videoPrompt,/旧动作/);
});
test('long general descriptions split first-frame and motion sections instead of repeating both in video',()=>{
 const {project,shot}=scene();shot.generalPrompt='想表达什么：让观众感到惊讶。\n首帧画面描述：黄色玩偶坐在桌前，窗外晴天。\n动作、镜头与声音：固定镜头，玩偶轻声说：「喂，你现在方便接电话吗？」。';const plan=shotPlan(project,shot,[]);
 assert.match(plan.imagePrompt,/坐在桌前，窗外晴天/);assert.doesNotMatch(plan.videoPrompt,/让观众感到惊讶|首帧画面描述|窗外晴天|旧动作/);assert.equal(count(plan.videoPrompt,'喂，你现在方便接电话吗？'),1);assert.match(plan.videoPrompt,/<d>\[Chinese\]/);
});
test('steady mode preserves the first-frame pose and speech instead of inventing human anatomy',()=>{
 const {project,shot}=scene();shot.videoPrompt='鼻翼轻张，抬下颌，右手压向手机，左手撑住桌沿，前推半米，说：「喂，你现在方便接电话吗？」。';shot.motionMode='steady';const plan=shotPlan(project,shot,[]);
 assert.doesNotMatch(plan.videoPrompt,/鼻翼|下颌|半米|压向/);assert.match(plan.videoPrompt,/两手位置/);assert.match(plan.videoPrompt,/camera holds still/);assert.equal(count(plan.videoPrompt,'喂，你现在方便接电话吗？'),1);assert.match(shot.videoPrompt,/鼻翼/);
});
test('short duration and inappropriate anatomy receive actionable diagnostics',()=>{
 const {project,shot}=scene();shot.frames=73;shot.videoPrompt='鼻翼轻张，缓缓呼吸。';const plan=shotPlan(project,shot,[]);assert.match(plan.warnings.join(''),/实验短片/);assert.match(plan.warnings.join(''),/对应部位/);assert.equal(plan.specification.width,736);assert.equal(plan.specification.native720,true);
});
test('native dimensions and export canvas are independent and native720 never silently shrinks',async()=>{
 const {project,shot}=scene();project.production.exportSize='1080x1920';const plan=shotPlan(project,shot,[]);assert.equal(plan.specification.width,576);assert.equal(plan.specification.height,1024);assert.equal(plan.specification.native720,false);
 assert.throws(()=>normalizeVideoOptions({profile:'native720',frames:175,aspect:'portrait'}),/不会自动降低/);assert.throws(()=>normalizeVideoOptions({profile:'native720',frames:124,aspect:'source'}),/选择横版/);
 const root=fileURLToPath(new URL('../',import.meta.url));for(const template of ['h3-fast','h3-base'])for(const [aspect,size] of [['portrait',[736,1280]],['landscape',[1280,736]],['square',[768,768]]]){const input=parseRequest({template,prompt:'固定机位轻微呼吸。',images:['first.png'],video:{frames:124,profile:'native720',aspect}}),graph=compileGraph(await loadGraph(root,template),input,'native-test'),scale=Object.values(graph).find(n=>n.class_type==='ImageScale');assert.deepEqual([scale.inputs.width,scale.inputs.height],size);assert.equal(videoSpecification(input.video).native720,true);}
});
test('changing motion mode keeps the imported image approved and invalidates only its old video',()=>{
 const {project,shot}=scene();shot.frameApproval={jobId:'image',sha256:'hash'};const frame={id:'image',source:'external',status:'success',outputs:[{kind:'image',sha256:'hash'}]},plan=shotPlan(project,shot,[]),video={status:'success',frameJobId:'image',externalFrameHash:'hash',videoSignature:plan.videoSignature,outputs:[{kind:'video'}]};assert.ok(frameMatches(project,shot,frame,[]));assert.ok(videoMatches(project,shot,video,[]));shot.motionMode='steady';assert.ok(frameMatches(project,shot,frame,[]));assert.ok(!videoMatches(project,shot,video,[]));
});
test('preformatted H3 prompts preserve tagged speech, actions and sound without nested field headings',()=>{
 const {project,shot}=scene();shot.generalPrompt='For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n\nintegrated_multimodal_description: [Shot 1] The camera slowly pushes in. The doll (S1) says: <d>[Chinese] 你好。<\/d> The doll nods.\n\noverall_soundscape: Quiet office room tone.\n\nnon_diegetic_music: N/A';const plan=shotPlan(project,shot,[]);assert.equal(count(plan.videoPrompt,'integrated_multimodal_description:'),1);assert.equal(count(plan.videoPrompt,'<d>'),1);assert.match(plan.videoPrompt,/camera slowly pushes in/);assert.match(plan.videoPrompt,/doll nods/);assert.match(plan.videoPrompt,/overall_soundscape: Quiet office room tone\./);
});
test('two lines spoken by one character keep the same stable speaker number',()=>{
 const {project,shot}=scene();shot.director.dialogue='';shot.videoPrompt='玩偶说：「第一句话。」。玩偶接着说：「第二句话。」';const plan=shotPlan(project,shot,[]);assert.equal(count(plan.videoPrompt,'(S1)'),2);assert.equal(count(plan.videoPrompt,'(S2)'),0);
});
