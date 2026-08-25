'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL 환경 변수가 필요합니다.');

const localDatabase = /localhost|127\.0\.0\.1/.test(connectionString);
let normalizedConnectionString = connectionString;
if (!localDatabase) {
  const parsed = new URL(connectionString);
  parsed.searchParams.delete('sslmode');
  normalizedConnectionString = parsed.toString();
}

const schemaPath = path.resolve(__dirname, '..', 'supabase', 'schema.sql');
const client = new Client({
  connectionString: normalizedConnectionString,
  ssl: localDatabase ? undefined : { rejectUnauthorized: false },
});

(async () => {
  await client.connect();
  try {
    await client.query(fs.readFileSync(schemaPath, 'utf8'));
    console.log('완료: Supabase 운영 스키마가 준비되었습니다.');
  } finally {
    await client.end();
  }
})().catch(error => {
  console.error(`스키마 적용 실패: ${error.message}`);
  process.exitCode = 1;
});
