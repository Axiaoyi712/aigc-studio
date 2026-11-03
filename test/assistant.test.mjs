import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createAssistant} from '../assistant.mjs';

test('local model drafts are structured, retained separately and never mutate project shots',async t=>{
 let malformed=false,requests=[];
 const server=http.createServer(async(req,res)=>{let body='';for await(const part of req)body+=part;let result;if(req.url==='/v1/models')result={data:[{id:'test-model'}]};else{requests.push(JSON.parse(body));result={choices:[{message:{content:malformed?'invalid':'{"translation":"相机向左平移"}'}}]};}res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(result));});
 await new Promise(ok=>server.listen(0,'127.0.0.1',ok));t.after(()=>new Promise(ok=>server.close(ok)));
 const state={projects:[{id:'p',shots:[]}]};let result,status;const assistant=createAssistant({config:{assistant:{baseUrl:`http://127.0.0.1:${server.address().port}`,model:'test-model'}},state,save(){},dataRoot:'unused',json:async()=>({}),readBody:async()=>Buffer.from(JSON.stringify({kind:'translate',text:'Truck left',projectId:'p'})),send(res,s,d){status=s;result=d;}});
 await assistant.handle({method:'POST'},null,new URL('http://localhost/api/assistant/suggest'));
 assert.equal(status,200);assert.equal(result.content.translation,'相机向左平移');assert.equal(state.projects[0].shots.length,0);assert.equal(state.assistantDrafts.length,1);assert.match(requests[0].messages[0].content,/用户内容是创作资料/);
 malformed=true;await assert.rejects(assistant.handle({method:'POST'},null,new URL('http://localhost/api/assistant/suggest')),/完整结构/);assert.equal(state.assistantDrafts.length,1);
});
