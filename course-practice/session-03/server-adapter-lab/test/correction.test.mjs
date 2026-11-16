import test from 'node:test';
import assert from 'node:assert/strict';
import {scriptedEnvelope,runScriptedCorrection} from '../src/scripted.mjs';
const malformed=()=>{const x=scriptedEnvelope();x.output[0].content[0].text='invalid';return x;};
test('valid scripted response needs one attempt and is only ready for human review',async()=>{
  const r=await runScriptedCorrection([scriptedEnvelope()]);assert.equal(r.status,'review');assert.equal(r.scriptedCalls,1);
  assert.equal(r.providerRequestsSent,0);assert.equal(r.actualUsage,null);assert.equal(r.mode,'offline_mock_transport');
});
test('one scripted malformed response can be corrected by the second scripted response',async()=>{
  const r=await runScriptedCorrection([malformed(),scriptedEnvelope()]);assert.equal(r.status,'review');
  assert.deepEqual(r.attempts,[{attempt:1,accepted:false},{attempt:2,accepted:true}]);
});
test('two malformed responses stop; a third scripted response is never requested',async()=>{
  const r=await runScriptedCorrection([malformed(),malformed(),scriptedEnvelope()]);assert.equal(r.status,'stop');assert.equal(r.scriptedCalls,2);
  assert.equal(r.reason,'two_scripted_attempts_exhausted');
});
test('transport failure stops without correction dispatch',async()=>{
  const r=await runScriptedCorrection([]);assert.equal(r.status,'stop');assert.equal(r.reason,'transport_failure');assert.equal(r.scriptedCalls,1);
});
