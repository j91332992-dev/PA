'use strict';

// Usage (PowerShell):
// $env:DATABASE_URL='<Supabase Transaction Pooler URL>'
// $env:SEED_JSON_PATH='data/wardrobe.json'
// node scripts/migrate-json-to-postgres.js
// The server only seeds an empty cloud DB; it never overwrites an existing DB.
if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL 환경 변수가 필요합니다.');
if(!process.env.SEED_JSON_PATH)throw new Error('SEED_JSON_PATH 환경 변수가 필요합니다.');
const {ready,closeStorage}=require('../backend/server');
ready.then(async()=>{
  console.log('완료: 비어 있던 PostgreSQL 데이터베이스에 로컬 옷장 데이터를 저장했습니다.');
  await closeStorage();
}).catch(async error=>{
  console.error(`이관 실패: ${error.message}`);
  await closeStorage().catch(()=>{});
  process.exitCode=1;
});
