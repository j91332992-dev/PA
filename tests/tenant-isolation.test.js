'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'wardrobe-tenants-'));
process.env.DATA_PATH=path.join(tmp,'db.json');process.env.PORT='0';process.env.DEVICE_TOKEN='tenant-device';process.env.JWT_SECRET='tenant-secret';process.env.SIMULATION_ENABLED='false';
const {server}=require('../backend/server');let origin;
const call=async(pathname,options={})=>{const r=await fetch(origin+pathname,{...options,headers:{'content-type':'application/json',...options.headers}});return{status:r.status,body:await r.json()}};
const auth=token=>({authorization:`Bearer ${token}`});
const claim=async(kind,deviceId,token)=>{const intent=await call(`/api/${kind}/${deviceId}/claim-intent`,{method:'POST',headers:auth(token)});assert.equal(intent.status,200);const result=await call(`/api/${kind}/${deviceId}/claim`,{method:'POST',headers:auth(token),body:JSON.stringify({claimToken:intent.body.claimToken})});assert.equal(result.status,200);return result};
test.before(async()=>{await new Promise(ok=>server.listen(0,'127.0.0.1',ok));origin=`http://127.0.0.1:${server.address().port}`});
test.after(()=>server.close());
test('users only receive their own garments, rods and hangers',async()=>{
  const a=await call('/api/auth/signup',{method:'POST',body:JSON.stringify({name:'A',email:'a@example.com',password:'password-123'})});assert.equal(a.status,201);
  const shirt=await call('/api/garments',{method:'POST',headers:auth(a.body.token),body:JSON.stringify({name:'A의 셔츠',tagUid:'04112233445566'})});assert.equal(shirt.status,201);
  const device=await call('/api/gateway/status',{method:'POST',headers:{authorization:'Bearer tenant-device'},body:JSON.stringify({gatewayId:'GW-AABBCC',hangerId:'HC-AABBCC',state:'PRESENT',tagUid:'04112233445566',sequence:1,bootId:'a'})});assert.equal(device.status,200);
  await claim('gateways','GW-AABBCC',a.body.token);await claim('hangers','HC-AABBCC',a.body.token);
  const b=await call('/api/auth/signup',{method:'POST',body:JSON.stringify({name:'B',email:'b@example.com',password:'password-123'})});assert.equal(b.status,201);
  const bShirt=await call('/api/garments',{method:'POST',headers:auth(b.body.token),body:JSON.stringify({name:'B의 셔츠',tagUid:'04112233445566'})});assert.equal(bShirt.status,201,'different wardrobes may use the same NFC UID');
  const aSnap=await call('/api/snapshot',{headers:auth(a.body.token)}),bSnap=await call('/api/snapshot',{headers:auth(b.body.token)});
  assert.deepEqual(aSnap.body.garments.map(g=>g.name),['A의 셔츠']);assert.equal(aSnap.body.gateways.length,1);assert.equal(aSnap.body.hangers.length,1);
  assert.deepEqual(bSnap.body.garments.map(g=>g.name),['B의 셔츠']);assert.equal(bSnap.body.gateways.length,0);assert.equal(bSnap.body.hangers.length,0);
  const forbidden=await call(`/api/garments/${shirt.body.id}`,{method:'DELETE',headers:auth(b.body.token)});assert.equal(forbidden.status,404);
  const command=await call('/api/commands',{method:'POST',headers:auth(b.body.token),body:JSON.stringify({targets:['HC-AABBCC']})});assert.equal(command.status,404);
});

test('one browser can sign up A, log out, then sign up B and C without IP or local token coupling',async()=>{
  const accounts=[];
  for(const [name,email,tagUid] of [['계정A','browser-a@example.com','04AA0000000001'],['계정B','browser-b@example.com','04BB0000000002'],['계정C','browser-c@example.com','04CC0000000003']]){
    // A browser logout only removes its local token. The signup endpoint must
    // not use that old token, PC identity, IP, or Wi-Fi as a registration key.
    const signup=await call('/api/auth/signup',{method:'POST',body:JSON.stringify({name,email,password:'password-123'})});
    assert.equal(signup.status,201);
    accounts.push(signup.body);
    const status=await call('/api/auth/status',{headers:auth(signup.body.token)});
    assert.equal(status.status,200);assert.equal(status.body.user.email,email);
    const garment=await call('/api/garments',{method:'POST',headers:auth(signup.body.token),body:JSON.stringify({name:`${name}의 옷`,tagUid})});
    assert.equal(garment.status,201);
  }
  for(let i=0;i<accounts.length;i++){
    const snap=await call('/api/snapshot',{headers:auth(accounts[i].token)});
    assert.equal(snap.status,200);assert.equal(snap.body.garments.length,1);
    assert.equal(snap.body.garments[0].name,`${['계정A','계정B','계정C'][i]}의 옷`);
  }
  const duplicateEmail=await call('/api/auth/signup',{method:'POST',body:JSON.stringify({name:'새이름',email:'browser-a@example.com',password:'password-123'})});
  assert.equal(duplicateEmail.status,409);
  const duplicateName=await call('/api/auth/signup',{method:'POST',body:JSON.stringify({name:'계정A',email:'new-email@example.com',password:'password-123'})});
  assert.equal(duplicateName.status,409);
});
