import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptAnswer} from './accept-answer.mjs';
const valid={kind:'explain',ruleId:'players',cardId:null,explanation:'Open Shed supports two to six players.'};
test('accept exact players answer',()=>assert.equal(acceptAnswer(JSON.stringify(valid),'players'),true));
test('reject malformed JSON and null',()=>{assert.equal(acceptAnswer('{bad','players'),false);assert.equal(acceptAnswer('null','players'),false);});
test('reject extra action property',()=>assert.equal(acceptAnswer(JSON.stringify({...valid,execute:true}),'players'),false));
test('reject wrong citation',()=>assert.equal(acceptAnswer(JSON.stringify({...valid,ruleId:'scoring'}),'players'),false));
test('reject invented private card',()=>assert.equal(acceptAnswer(JSON.stringify({...valid,cardId:'opponent-card'}),'players'),false));
test('reject incorrect kind',()=>assert.equal(acceptAnswer(JSON.stringify({...valid,kind:'suggest'}),'players'),false));
test('reject unsupported scenario',()=>assert.equal(acceptAnswer(JSON.stringify(valid),'free-form'),false));
test('reject explanation outside 10..1200 characters',()=>{for(const explanation of ['tiny','x'.repeat(1201),false])assert.equal(acceptAnswer(JSON.stringify({...valid,explanation}),'players'),false);});
test('accept exact permitted suggestion and explicit boundary ask',()=>{
  assert.equal(acceptAnswer(JSON.stringify({...valid,kind:'suggest',ruleId:'turn',cardId:'practice-red-3'}),'suggest'),true);
  assert.equal(acceptAnswer(JSON.stringify({...valid,kind:'ask',ruleId:null}),'hidden'),true);
});
