import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const root=process.env.AIGC_TEST_ROOT||resolve(import.meta.dirname,'..');
const {mountProductionUI,productionClick}=await import(pathToFileURL(resolve(root,'public/production-ui.js')));

function setup(overrides={}){
 let project=null;const elements=new Map();
 elements.set('.project-toolbar',{after(node){elements.set('#'+node.id,node);}});
 const panel={querySelector(selector){return elements.get(selector)||null;}};
 globalThis.document={querySelector(){return panel;},createElement(){return {setAttribute(){}};}};
 const context={getDraft:()=>project,isDirty:()=>true,save:async()=>{throw Error('Saving should not block opening a project folder');},...overrides};
 mountProductionUI(context);project={id:'project-id'};
 const button={dataset:{},textContent:'打开项目文件夹',disabled:false,hasAttribute(name){return name==='data-open-project-folder';}};
 return {context,button,elements};
}

test('dirty project opens without saving and shows progress, the real path and a copy action',async()=>{
 let finish;const calls=[];
 const f=setup({api:async(path,body)=>{calls.push({path,body});return new Promise(resolve=>{finish=resolve;});}});
 const pending=productionClick(f.button);
 assert.equal(f.button.disabled,true);assert.match(f.button.textContent,/正在打开/);
 assert.equal(calls[0].path,'/api/projects/project-id/folder');
 finish({path:"E:\\项目 [参考]\\首帧",message:'已切换到文件夹'});await pending;
 assert.equal(f.button.disabled,false);assert.equal(f.button.textContent,'打开项目文件夹');
 const feedback=f.elements.get('#project-folder-result');assert.match(feedback.innerHTML,/E:\\项目/);assert.match(feedback.innerHTML,/data-copy-folder-path/);
});

test('failed open restores the button and keeps the error beside the project toolbar',async()=>{
 const f=setup({api:async()=>{throw Error('资源管理器打开失败');}});
 await assert.rejects(productionClick(f.button),/打开失败/);
 assert.equal(f.button.disabled,false);assert.equal(f.button.textContent,'打开项目文件夹');
 const feedback=f.elements.get('#project-folder-result');assert.match(feedback.className,/error/);assert.match(feedback.innerHTML,/打开失败/);
});

test('opening a newly edited shot still saves it before requesting its folder',async()=>{
 const sequence=[];const f=setup({save:async()=>sequence.push('save'),api:async()=>{sequence.push('open');return {path:'E:\\项目\\镜头001',message:'已切换到文件夹'};}});
 f.button.dataset.openShotFolder='shot-id';await productionClick(f.button);assert.deepEqual(sequence,['save','open']);
});
