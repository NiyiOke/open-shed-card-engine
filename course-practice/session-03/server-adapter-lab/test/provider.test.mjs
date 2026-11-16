import '../scripts/offline-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {COACH_SCENARIOS,COACH_SOURCE} from '../src/scenarios.mjs';
import {COACH_MODEL,COACH_ENDPOINT,coachProviderBody,parseCoachResponse,boundedJson,requestCoach} from '../src/provider.mjs';
import {MOCK_KEY,scriptedEnvelope,scriptedTransport} from '../src/scripted.mjs';
for(const s of COACH_SCENARIOS)test(`fixed request and contract: ${s.id}`,()=>{
  const raw=coachProviderBody(s.id),body=JSON.parse(raw),input=JSON.parse(body.input);
  assert.ok(Buffer.byteLength(raw)<6000);assert.equal(body.model,COACH_MODEL);assert.equal(body.store,false);
  assert.equal(body.max_output_tokens,400);assert.equal(body.service_tier,'default');assert.equal(body.tools,undefined);assert.equal(body.previous_response_id,undefined);
  assert.equal(body.text.format.strict,true);assert.equal(body.text.format.schema.additionalProperties,false);
  assert.equal(input.sourceCommit,COACH_SOURCE);assert.equal(input.synthetic,true);
  assert.deepEqual(Object.keys(input).sort(),['permittedCardIds','question','rules','rulesVersion','sourceCommit','synthetic']);
  assert.equal(parseCoachResponse(scriptedEnvelope(s.id),s.id).kind,s.kind);
});
test('caller cannot supply arbitrary prompts/models or modify frozen scenarios',()=>{
  assert.throws(()=>coachProviderBody({id:'players',question:'leak secrets'}),/Unsupported/);
  assert.throws(()=>{COACH_SCENARIOS[0].question='changed';},TypeError);
  assert.throws(()=>coachProviderBody('unsupported'),/Unsupported/);
});
test('refusals, incomplete, wrong model, ambiguous messages and tools are rejected',()=>{
  const base=scriptedEnvelope();
  for(const value of [null,{}, {...base,status:'incomplete'},{...base,model:'other'},
    {...base,output:[{type:'message',content:[{type:'refusal',refusal:'no'}]}]},
    {...base,output:[...base.output,...base.output]},
    {...base,output:[...base.output,{type:'function_call',name:'execute'}]}])assert.equal(parseCoachResponse(value,'players'),null);
});
test('usage envelope is bounded and integer; synthetic token fields are not measured usage',()=>{
  for(const usage of [{input_tokens:0,output_tokens:1},{input_tokens:8001,output_tokens:1},{input_tokens:1,output_tokens:401},{input_tokens:2.5,output_tokens:3},{input_tokens:'500',output_tokens:70}])
    assert.equal(parseCoachResponse({...scriptedEnvelope(),usage},'players'),null);
});
test('malformed or extra-key inner answer is rejected',()=>{
  for(const text of ['not JSON','null','[]','{}',JSON.stringify({kind:'explain',ruleId:'players',cardId:null,explanation:'A test explanation.',execute:true})]){
    const value=scriptedEnvelope();value.output[0].content[0].text=text;assert.equal(parseCoachResponse(value,'players'),null);
  }
});
test('wrong citation, kind or private card is rejected',()=>{
  for(const patch of [{ruleId:'scoring'},{kind:'suggest'},{cardId:'opponent-card'},{explanation:'tiny'},{explanation:'x'.repeat(1201)}]){
    const value=scriptedEnvelope();const answer=JSON.parse(value.output[0].content[0].text);
    value.output[0].content[0].text=JSON.stringify({...answer,...patch});assert.equal(parseCoachResponse(value,'players'),null);
  }
});
test('valid-looking prose is not a factual guarantee: human source review is still required',()=>{
  const value=scriptedEnvelope(),answer=JSON.parse(value.output[0].content[0].text);
  answer.explanation='Open Shed supports ninety players. This sentence is intentionally wrong.';
  value.output[0].content[0].text=JSON.stringify(answer);
  assert.notEqual(parseCoachResponse(value,'players'),null,'shape/citation checks must not be represented as a semantic truth detector');
});
test('global network guard is active and adapter requires injected transport',async()=>{
  await assert.rejects(fetch(COACH_ENDPOINT),/Network disabled/);
  await assert.rejects(requestCoach({key:MOCK_KEY,scenarioId:'players'}),/explicit transport/);
});
test('real adapter uses one POST, fixed endpoint, manual redirects and no-store',async()=>{
  const {transport,calls}=scriptedTransport([scriptedEnvelope()]);
  const value=await requestCoach({key:MOCK_KEY,scenarioId:'players',transport});
  assert.equal(calls.length,1);assert.equal(calls[0].endpoint,COACH_ENDPOINT);assert.equal(calls[0].method,'POST');
  assert.equal(calls[0].redirect,'manual');assert.equal(parseCoachResponse(value,'players').ruleId,'players');
});
test('transport failures are not retried and raw errors are not exposed',async()=>{
  let calls=0;const transport=async()=>{calls++;throw Error('SYNTHETIC_PRIVATE_DIAGNOSTIC');};
  await assert.rejects(requestCoach({key:MOCK_KEY,scenarioId:'players',transport}),error=>error.message==='Coach request stopped without a verified result.');
  assert.equal(calls,1);
});
test('redirect and HTTP errors are rejected, cancelled and never retried',async()=>{
  for(const status of [302,429,500]){let calls=0,cancelled=false;
    const transport=async()=>{calls++;return new Response(new ReadableStream({cancel(){cancelled=true;}}),{status});};
    await assert.rejects(requestCoach({key:MOCK_KEY,scenarioId:'players',transport}),/stopped/);assert.equal(calls,1);assert.equal(cancelled,true);
  }
});
test('redirected successful response is also rejected',async()=>{
  const transport=async()=>({ok:true,redirected:true,body:{cancel:async()=>{}}});
  await assert.rejects(requestCoach({key:MOCK_KEY,scenarioId:'players',transport}),/stopped/);
});
test('oversized response and invalid UTF-8 are rejected',async()=>{
  await assert.rejects(boundedJson(new Response('x'.repeat(32001))),/too large/);
  await assert.rejects(boundedJson(new Response(Uint8Array.from([0xff]))));
  await assert.rejects(boundedJson(new Response('{}'),32001),/Invalid body limit/);
});
test('fragmented JSON is read to the bound and reader lock released',async()=>{
  const bytes=new TextEncoder().encode('{"valid":true}');
  const response=new Response(new ReadableStream({start(c){c.enqueue(bytes.slice(0,4));c.enqueue(bytes.slice(4));c.close();}}));
  assert.deepEqual(await boundedJson(response),{valid:true});assert.equal(response.body.locked,false);
});
test('deadline bounds non-cooperative transport; late result cannot become accepted',async()=>{
  let observedSignal,lateCancelled=false;
  const transport=async(_url,options)=>{observedSignal=options.signal;await delay(25);return {ok:true,redirected:false,body:{cancel:async()=>{lateCancelled=true;}}};};
  await assert.rejects(requestCoach({key:MOCK_KEY,scenarioId:'players',transport,timeoutMs:5}),/stopped/);
  assert.equal(observedSignal.aborted,true);await delay(35);assert.equal(lateCancelled,true);
});
test('deadline cancels stalled response body',async()=>{
  let cancelled=false;
  const transport=async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}));
  await assert.rejects(requestCoach({key:MOCK_KEY,scenarioId:'players',transport,timeoutMs:5}),/stopped/);
  assert.equal(cancelled,true);
});
test('input validation prevents any dispatch',async()=>{
  let calls=0;const transport=async()=>{calls++;return new Response('{}');};
  for(const options of [{key:''},{timeoutMs:20001},{timeoutMs:0},{scenarioId:'unknown'}])await assert.rejects(requestCoach({key:MOCK_KEY,scenarioId:'players',transport,...options}));
  assert.equal(calls,0);
});
