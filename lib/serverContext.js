const { GeminiKnowledgeBase, GeminiFileSearchService } = require('./gemini');
const { SupabaseService } = require('./supabase');

let knowledgeInstance = null;
let knowledgeInitPromise = null;
let fileSearchInstance = null;
let supabaseInstance = null;

async function ensureKnowledge() {
  if (!knowledgeInstance) {
    knowledgeInstance = new GeminiKnowledgeBase({});
  }

  if (!knowledgeInitPromise) {
    knowledgeInitPromise = knowledgeInstance.init().catch((error) => {
      console.error('[serverContext] Gemini initialization failed:', error?.message || error);
      knowledgeInitPromise = null;
      return knowledgeInstance;
    });
  }

  try {
    await knowledgeInitPromise;
  } catch (error) {
    console.error('[serverContext] Gemini init awaiting failed:', error?.message || error);
  }

  return knowledgeInstance;
}

async function getKnowledgeBase() {
  return ensureKnowledge();
}

async function getFileSearchService() {
  const knowledge = await ensureKnowledge();
  if (!fileSearchInstance) {
    fileSearchInstance = new GeminiFileSearchService({ apiKey: knowledge.apiKey });
  } else if (knowledge?.apiKey) {
    fileSearchInstance.setApiKey(knowledge.apiKey);
  }
  return fileSearchInstance;
}

function getSupabaseService() {
  if (!supabaseInstance) {
    supabaseInstance = new SupabaseService();
  }
  return supabaseInstance;
}

module.exports = {
  ensureKnowledge,
  getKnowledgeBase,
  getFileSearchService,
  getSupabaseService,
};
