'use strict';

// Serverless production entrypoint. Hardware state/LED commands stay on the
// local BLE + ESP-NOW hot path; durable cloud records use Supabase.
process.env.DISABLE_BACKGROUND_TASKS = 'true';

const { server } = require('../backend/server-v3');

// Keep HTTP routes and the existing /ws upgrade handler on one deployment.
module.exports = server;
