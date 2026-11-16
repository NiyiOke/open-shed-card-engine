// Intentional separate learner bug. The supplied adapter does not use this.
// Input is untrusted JSON text; return true only for the exact scenario contract.
export function acceptAnswer(text,scenarioId){
  try {const answer=JSON.parse(text);return typeof answer?.explanation==='string';}
  catch{return false;}
}
