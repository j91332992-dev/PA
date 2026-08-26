'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const os=require('os');
const path=require('path');

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'wardrobe-offline-'));
process.env.DATA_PATH=path.join(tmp,'db.json');
process.env.PORT='0';
process.env.DEVICE_TOKEN='offline-device';
process.env.JWT_SECRET='offline-secret';
process.env.OFFLINE_TIMEOUT_MS='500';
process.env.DISABLE_BACKGROUND_TASKS='true';
const {server}=require('../backend/server');

let origin;
async function call(route,options={}){
  const response=await fetch(origin+route,{
    ...options,
    headers:{'content-type':'application/json',...(options.headers||{})},
  });
  return {status:response.status,body:await response.json()};
}

test.before(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  origin=`http://127.0.0.1:${server.address().port}`;
});
test.after(()=>server.close());

test('an offline hanger durably moves its garment outside on the next snapshot',async()=>{
  const signup=await call('/api/auth/signup',{
    method:'POST',
    body:JSON.stringify({name:'Offline Owner',email:'offline@example.com',password:'0123456789'}),
  });
  const auth={authorization:`Bearer ${signup.body.token}`};
  const device={authorization:'Bearer offline-device'};
  await call('/api/gateway/status',{
    method:'POST',headers:device,
    body:JSON.stringify({gatewayId:'GW-0FF001',hangerId:'HC-0FF001',state:'PRESENT',tagUid:'04AABBCCDDEEFF',sequence:1,bootId:'offline-boot'}),
  });
  for(const [kind,id] of [['gateways','GW-0FF001'],['hangers','HC-0FF001']]){
  await call('/api/gateway/status',{
    method:'POST',headers:device,
    body:JSON.stringify({gatewayId:'GW-0FF001',hangerId:'HC-0FF001',state:'PRESENT',tagUid:'04AABBCCDDEEFF',sequence:2,bootId:'offline-boot'}),
  });
    const intent=await call(`/api/${kind}/${id}/claim-intent`,{method:'POST',headers:auth});
    const claimed=await call(`/api/${kind}/${id}/claim`,{
      method:'POST',headers:auth,body:JSON.stringify({claimToken:intent.body.claimToken}),
    });
    assert.equal(claimed.status,200);
  }
  const garment=await call('/api/garments',{
    method:'POST',headers:auth,
    body:JSON.stringify({name:'오프라인 확인 옷',tagUid:'04AABBCCDDEEFF'}),
  });
  assert.equal(garment.status,201);
  let snapshot=await call('/api/snapshot',{headers:auth});
  assert.equal(snapshot.body.garments[0].currentState,'IN_WARDROBE');
  assert.equal(snapshot.body.garments[0].currentHanger,'HC-0FF001');

  await new Promise(resolve=>setTimeout(resolve,550));
  snapshot=await call('/api/snapshot',{headers:auth});
  assert.equal(snapshot.body.hangers[0].state,'OFFLINE');
  assert.equal(snapshot.body.garments[0].currentState,'OUT');
  assert.equal(snapshot.body.garments[0].currentHanger,null);
});
