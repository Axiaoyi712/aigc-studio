const h=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let context,records=[];
export function mountDrivers(ctx,panel){
 context=ctx;records=[];
 panel.insertAdjacentHTML('beforeend',`<details class="production-references" id="depth-driver-panel"><summary>白膜／深度视频驱动（实验）</summary><p class="field-help">先在“资产定稿”选好人物和场景，再导入深度视频。动作由逐帧深度控制；生成首帧后请检查构图和身份。可选原生高清，或快速生成后AI精修至720p；两种方式会分别标注。</p><label>关联视频完整路径（推荐，不复制原视频）<input id="driver-path" placeholder="E:\\其他文件夹\\白膜视频.mp4"></label><button type="button" id="driver-link" class="project-button">关联本地视频</button><label>或从任意文件夹选择视频（导入一份到本项目）<input type="file" id="driver-upload-file" accept=".mp4,.mov,.mkv,.webm,.avi"></label><button type="button" id="driver-upload" class="project-button">导入所选视频</button><label>已关联的视频<select id="driver-select"><option>读取中…</option></select></label><p id="driver-info" class="field-help" role="status"></p><video id="driver-preview" controls preload="metadata" style="width:100%;max-height:300px"></video><div class="production-grid"><label>开始秒数<input id="driver-start" type="number" step="0.01" min="0" value="0"></label><label>结束秒数<input id="driver-end" type="number" step="0.01" min="0" value="3"></label></div><label>生成档位<select id="driver-quality"><option value="native720">原生高清 · 至少720p（较慢）</option><option value="preview">快速生成＋自动AI精修720p</option></select></label><button type="button" id="driver-add" class="project-button">此片段创建镜头</button><button type="button" id="driver-split" class="project-button">整段按约3秒创建镜头</button><p class="field-help">单镜头最多5.17秒。识别宽高、时长、帧率并按实际时间转换为24fps；原视频应为已处理的深度白膜。普通彩色视频不会自动变成深度图。已有镜头和原视频均保留。</p></details>`);
 void reload().catch(e=>{const node=document.querySelector('#driver-info');if(node)node.textContent=e.message;});
}
async function reload(){
 const pid=context.getDraft().id;
 const result=await context.api(`/api/projects/${pid}/drivers`);
 if(context.getDraft()?.id!==pid)return;
 records=result;const select=document.querySelector('#driver-select');
 if(!select)return;
 select.innerHTML='<option value="">选择视频</option>'+records.map(r=>`<option value="${r.id}">${h(r.name)}</option>`).join('');
 select.value=records.at(-1)?.id||'';select.onchange=show;show();
}
function show(){
 const r=records.find(r=>r.id===document.querySelector('#driver-select').value),v=document.querySelector('#driver-preview');
 v.hidden=!r;
 if(r){v.src=`/api/projects/${r.projectId}/drivers/${r.id}/file`;document.querySelector('#driver-end').value=Math.min(3,r.metadata.duration).toFixed(2);}
 document.querySelector('#driver-info').textContent=r?`${r.metadata.width}×${r.metadata.height} · ${r.metadata.duration.toFixed(2)}秒 · ${r.metadata.fps.toFixed(2)}fps · ${r.imported?'已导入本项目':'只关联原文件，未复制'}；正式输出短边至少720像素。`:'';
}
export async function driverClick(button){
 if(!['driver-link','driver-upload','driver-add','driver-split'].includes(button.id))return false;
 if(context.isDirty())await context.save();
 const pid=context.getDraft().id,base=`/api/projects/${pid}/drivers`,info=document.querySelector('#driver-info');
 info.textContent='正在识别或准备片段，请稍候…';
 if(button.id==='driver-link'){
  await context.api(base,{path:document.querySelector('#driver-path').value});await reload();
 }else if(button.id==='driver-upload'){
  const f=document.querySelector('#driver-upload-file').files[0];if(!f)throw Error('请先选择视频。');
  const response=await fetch(base,{method:'POST',headers:{'Content-Type':f.type||'application/octet-stream','X-File-Name':encodeURIComponent(f.name)},body:f});const data=await response.json();if(!response.ok)throw Error(data.error);await reload();
 }else{
  const r=records.find(r=>r.id===document.querySelector('#driver-select').value);if(!r)throw Error('请先关联或导入视频。');
  const split=button.id==='driver-split';
  await context.api(base+`/${r.id}/clips`,{start:split?0:Number(document.querySelector('#driver-start').value),end:split?r.metadata.duration:Number(document.querySelector('#driver-end').value),split,quality:document.querySelector('#driver-quality').value});
  localStorage.setItem('aigc-step-'+pid,'3');await context.reload();
 }
 return true;
}
