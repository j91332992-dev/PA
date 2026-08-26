'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'wardrobe-discovery-'));
process.env.DATA_PATH=path.join(tmp,'db.json');
process.env.PORT='0';
process.env.DEVICE_TOKEN='test-device';
process.env.JWT_SECRET='test-secret';
process.env.OFFLINE_TIMEOUT_MS='80';
process.env.DISCOVERY_RETENTION_MS='80';
process.env.DISABLE_BACKGROUND_TASKS='true';
const {server,closeStorage}=require('../backend/server');
let origin,token;

test.before(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  origin=`http://127.0.0.1:${server.address().port}`;
});

test.after(async()=>{
  await new Promise(resolve=>server.close(resolve));
  await closeStorage();
});

async function call(route,options={}){
  const response=await fetch(origin+route,{...options,headers:{'content-type':'application/json',...options.headers}});
  return {status:response.status,body:await response.json()};
}

async function claim(kind,deviceId){
  const headers={authorization:`Bearer ${token}`};
  const intent=await call(`/api/${kind}/${deviceId}/claim-intent`,{method:'POST',headers});
  assert.equal(intent.status,200);
  return call(`/api/${kind}/${deviceId}/claim`,{method:'POST',headers,body:JSON.stringify({claimToken:intent.body.claimToken})});
}

async function status(hangerId,sequence){
  return call('/api/gateway/status',{
    method:'POST',
    headers:{authorization:'Bearer test-device'},
    body:JSON.stringify({gatewayId:'GW-A1B2C3',hangerId,state:'EMPTY',sequence,bootId:'boot-discovery',channel:4}),
  });
}

test('two live discoveries remain separate, one claim registers only one, and stale discoveries disappear',async()=>{
  const signup=await call('/api/auth/signup',{method:'POST',body:JSON.stringify({name:'Discovery User',email:'discovery@example.com',password:'0123456789'})});
  assert.equal(signup.status,201);
  token=signup.body.token;

  assert.equal((await status('HC-AA0001',1)).status,200);
  assert.equal((await status('HC-AA0002',1)).status,200);
  assert.equal((await claim('gateways','GW-A1B2C3')).status,200);

  let snapshot=await call('/api/snapshot',{headers:{authorization:`Bearer ${token}`}});
  assert.deepEqual(snapshot.body.discoveredHangers.map(item=>item.hangerId).sort(),['HC-AA0001','HC-AA0002']);
  assert.equal(snapshot.body.hangers.length,0);

  assert.equal((await claim('hangers','HC-AA0001')).status,200);
  snapshot=await call('/api/snapshot',{headers:{authorization:`Bearer ${token}`}});
  assert.deepEqual(snapshot.body.hangers.map(item=>item.hangerId),['HC-AA0001']);
  assert.deepEqual(snapshot.body.discoveredHangers.map(item=>item.hangerId),['HC-AA0002']);

  await new Promise(resolve=>setTimeout(resolve,100));
  snapshot=await call('/api/snapshot',{headers:{authorization:`Bearer ${token}`}});
  assert.equal(snapshot.body.discoveredHangers.length,0);
});
