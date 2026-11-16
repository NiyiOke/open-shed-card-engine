import assert from 'node:assert/strict';
assert.equal(process.versions.node,'22.14.0','Use trainer-prepared Node 22.14.0. Do not remove the pin.');
assert.equal(typeof Response,'function');assert.equal(typeof AbortController,'function');
console.log(JSON.stringify({ready:true,node:process.versions.node,installRequired:false,providerRequestsSent:0}));
