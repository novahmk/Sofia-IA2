'use strict';

const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = require('../database');
const clientMemory = require('../clientMemory');
const conversationManager = require('../core/conversationManager');
const leadMemory = require('../leadSystem/leadMemory');

async function main() {
  const dbResult = await db.clearAllConversationHistory();
  const memoryResult = await clientMemory.clearAllConversationHistory();
  const stateResult = await conversationManager.clearAllConversationHistory();
  const leadResult = await leadMemory.clearAllConversationHistory();

  const result = {
    ok: true,
    timestamp: new Date().toISOString(),
    database: dbResult,
    clientMemory: memoryResult,
    conversationState: stateResult,
    leadMemory: leadResult,
  };

  console.log(JSON.stringify(result, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exit(1);
  });