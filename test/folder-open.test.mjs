import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const root=process.env.AIGC_TEST_ROOT||resolve(import.meta.dirname,'..');
const {createStorage}=await import(pathToFileURL(resolve(root,'storage.mjs')));

function fixture(t){
 const dir=mkdtempSync(resolve(tmpdir(),'aigc-folder-'));
 const project={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',name:"中文项目 [参考] '单引号'",shots:[],characters:[]};
 const state={projects:[project],assets:[],uploads:{},jobs:[],exports:[],batchQueue:[]};
 const storage=createStorage({comfyRoot:resolve(dir,'comfy'),projectStorage:true},state,resolve(dir,'data'));
 const path=storage.projectFolder(project);mkdirSync(path,{recursive:true});
 const calls=[],spawned=[];
 t.mock.method(childProcess,'execFile',(command,args,options,callback)=>{calls.push({command,args,options,callback});return {};});
 t.mock.method(childProcess,'spawn',()=>{spawned.push(true);const child=new EventEmitter();child.unref=()=>{};queueMicrotask(()=>child.emit('spawn'));return child;});
 syncBuiltinESMExports();
 t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();rmSync(dir,{recursive:true,force:true});});
 const url=new URL('http://127.0.0.1/api/projects/'+project.id+'/folder');
 return {storage,path,calls,spawned,url};
}

test('folder response waits for the native opener and uses one literal Unicode path',async t=>{
 const f=fixture(t);let response,finished=false;
 const pending=f.storage.handle({method:'POST'},{},f.url,(_res,status,body)=>{response={status,body};}).then(()=>{finished=true;});
 await Promise.resolve();
 assert.equal(f.calls.length,1);assert.equal(f.spawned.length,0);assert.equal(finished,false);
 const call=f.calls[0];assert.equal(call.command,'powershell.exe');assert.ok(call.args.includes('-STA'));
 assert.equal(call.args.at(-2),'-LiteralPath');assert.equal(call.args.at(-1),f.path);assert.equal(call.options.windowsHide,true);
 call.callback(null,JSON.stringify({path:f.path,focused:true,reused:true}));await pending;
 assert.equal(response.status,200);assert.equal(response.body.path,f.path);assert.equal(response.body.focused,true);assert.equal(response.body.reused,true);
});

test('native opener failure cannot be reported as a successful folder open',async t=>{
 const f=fixture(t);let sent=false;
 const pending=f.storage.handle({method:'POST'},{},f.url,()=>{sent=true;});
 assert.equal(f.calls.length,1);f.calls[0].callback(new Error('Explorer failed'));
 await assert.rejects(pending,error=>error.status===500&&error.message.includes(f.path));assert.equal(sent,false);
});

test('an opened window that Windows does not foreground gets an accurate response',async t=>{
 const f=fixture(t);let body;
 const pending=f.storage.handle({method:'POST'},{},f.url,(_res,_status,value)=>{body=value;});
 assert.equal(f.calls.length,1);f.calls[0].callback(null,JSON.stringify({path:f.path,focused:false,reused:true}));await pending;
 assert.equal(body.focused,false);assert.match(body.message,/任务栏/);
});
