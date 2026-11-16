import assert from 'node:assert/strict';
import './check-setup.mjs';
import './offline-guard.mjs';
import {scriptedEnvelope,runScriptedCorrection} from '../src/scripted.mjs';
assert.equal(process.argv.length,2,'No live mode, API key, endpoint or prompt arguments are accepted.');
const valid=scriptedEnvelope(),bad=structuredClone(valid);bad.output[0].content[0].text='not JSON';
for(const [caseName,envelopes] of [['valid',[valid]],['one_scripted_correction',[bad,valid]],['stop_after_two',[bad,bad,valid]]]){
  console.log(JSON.stringify({caseName,...await runScriptedCorrection(envelopes)}));
}
