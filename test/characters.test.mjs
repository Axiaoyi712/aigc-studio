import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {validateCharacters,characterContext} from '../characters.mjs';
test('character validation and per-shot selection preserve fixed references and reject scene assets',()=>{
  const a={id:randomUUID(),category:'character'},b={id:randomUUID(),category:'character'},scene={id:randomUUID(),category:'scene'};
  const roles=validateCharacters([{id:randomUUID(),name:'A',description:'Fixed face',referenceIds:[a.id]},{id:randomUUID(),name:'B',description:'Fixed clothes',referenceIds:[b.id]}],[a,b,scene]);
  const both=characterContext({characters:roles},{referenceIds:[]});assert.deepEqual(both.referenceIds,[a.id,b.id]);
  const one=characterContext({characters:roles},{characterIds:[roles[1].id],referenceIds:[scene.id,b.id]});
  assert.deepEqual(one.referenceIds,[b.id,scene.id]);assert.equal(one.roles.length,1);assert.notEqual(one.signature,both.signature);
  assert.equal(characterContext({characters:roles},{characterIds:[],referenceIds:[]}).signature,null);
  assert.throws(()=>validateCharacters([{...roles[0],referenceIds:[scene.id]}],[a,b,scene]),/角色/);
  assert.throws(()=>validateCharacters([roles[0],roles[0]],[a,b,scene]),/编号/);
  assert.throws(()=>validateCharacters([null],[a,b]),/无效/);
});

test('a role can retain twenty fixed references and rejects a twenty-first',()=>{
  const assets=Array.from({length:21},()=>({id:randomUUID(),category:'character'})),role={id:randomUUID(),name:'A',description:'Fixed identity',referenceIds:assets.slice(0,20).map(a=>a.id)};
  assert.equal(validateCharacters([role],assets)[0].referenceIds.length,20);
  assert.throws(()=>validateCharacters([{...role,referenceIds:assets.map(a=>a.id)}],assets),/20/);
});
