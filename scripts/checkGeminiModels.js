const fs = require('fs');
const path = require('path');
const envPath = path.join(process.cwd(), '.env');
const envText = fs.readFileSync(envPath, 'utf8');
const env = envText.split(/\r?\n/).filter(Boolean).filter(l => !l.trim().startsWith('#')).reduce((acc, line) => {
  const match = line.match(/^\s*([^=]+)=(.*)$/);
  if (match) {
    acc[match[1].trim()] = match[2].replace(/^"|"$/g, '');
  }
  return acc;
}, {});
Object.assign(process.env, env);

const { GoogleGenerativeAI } = require('@google/generative-ai');
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
const GEMINI_API_VERSION = process.env.GEMINI_API_VERSION || 'v1';
const FALLBACK = process.env.GEMINI_FALLBACK_MODEL || 'gemini-1.5-pro';

const candidates = [];
candidates.push({model: GEMINI_MODEL, apiVersion: GEMINI_API_VERSION});
candidates.push({model: GEMINI_MODEL});
const stripped = GEMINI_MODEL.replace(/-(flash|pro)$/i, '');
if (stripped !== GEMINI_MODEL) {
  candidates.push({model: stripped, apiVersion: GEMINI_API_VERSION});
  candidates.push({model: stripped});
}
candidates.push({model: `models/${GEMINI_MODEL}`, apiVersion: GEMINI_API_VERSION});
candidates.push({model: `models/${GEMINI_MODEL}`});
if (stripped !== GEMINI_MODEL) {
  candidates.push({model: `models/${stripped}`, apiVersion: GEMINI_API_VERSION});
  candidates.push({model: `models/${stripped}`});
}
candidates.push({model: FALLBACK, apiVersion: GEMINI_API_VERSION});
candidates.push({model: FALLBACK});

(async () => {
  for (const c of candidates) {
    try {
      console.log('Trying', JSON.stringify(c));
      const model = genAI.getGenerativeModel({ model: c.model }, c.apiVersion ? { apiVersion: c.apiVersion } : undefined);
      console.log('OK', c);
    } catch (err) {
      console.error('ERR', c, err.message);
    }
  }

  try {
    const list = await genAI.listModels?.();
    console.log('ListModels:', list);
  } catch (listErr) {
    console.error('ListModels failed:', listErr && listErr.message ? listErr.message : listErr);
  }
})();