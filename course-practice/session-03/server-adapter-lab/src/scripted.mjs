import {coachScenario,COACH_RULES} from './scenarios.mjs';
import {COACH_MODEL,COACH_ENDPOINT,requestCoach,parseCoachResponse} from './provider.mjs';
export const MOCK_KEY='synthetic-not-a-secret';
export function scriptedEnvelope(scenarioId='players'){
  const scenario=coachScenario(scenarioId);if(!scenario)throw Error('Unknown scripted scenario.');
  return {model:COACH_MODEL,status:'completed',usage:{input_tokens:500,output_tokens:70},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({
    kind:scenario.kind,ruleId:scenario.rule,cardId:scenario.kind==='suggest'?'practice-red-3':null,
    explanation:scenario.rule?COACH_RULES[scenario.rule]:'I cannot see hidden cards or execute a move. Please use the approved rules and human review.',
  })}]}]};
}
export function scriptedTransport(envelopes){
  const queue=structuredClone(envelopes),calls=[];
  const transport=async(url,options)=>{
    if(url!==COACH_ENDPOINT||options.headers.Authorization!==`Bearer ${MOCK_KEY}`)throw Error('Only the synthetic local transport is supported.');
    calls.push({endpoint:url,method:options.method,redirect:options.redirect,body:JSON.parse(options.body)});
    if(!queue.length)throw Error('Scripted queue exhausted.');
    return new Response(JSON.stringify(queue.shift()),{headers:{'Content-Type':'application/json'}});
  };
  return {transport,calls};
}
export async function runScriptedCorrection(envelopes,scenarioId='players'){
  // No caller-supplied transport or retry limit: this is MOCK ONLY, max two.
  const {transport,calls}=scriptedTransport(envelopes),attempts=[];
  for(let attempt=1;attempt<=2;attempt++){
    let parsed=null;
    try{parsed=parseCoachResponse(await requestCoach({scenarioId,key:MOCK_KEY,transport}),scenarioId);}
    catch{return {mode:'offline_mock_transport',status:'stop',reason:'transport_failure',attempts,scriptedCalls:calls.length,providerRequestsSent:0,actualUsage:null};}
    attempts.push({attempt,accepted:parsed!==null});
    if(parsed)return {mode:'offline_mock_transport',status:'review',attempts,answer:parsed,scriptedCalls:calls.length,providerRequestsSent:0,actualUsage:null};
  }
  return {mode:'offline_mock_transport',status:'stop',reason:'two_scripted_attempts_exhausted',attempts,scriptedCalls:calls.length,providerRequestsSent:0,actualUsage:null};
}
