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

const candidates = [
  { model: process.env.GEMINI_MODEL || 'gemini-1.5-flash', apiVersion: process.env.GEMINI_API_VERSION || 'v1' },
  { model: process.env.GEMINI_FALLBACK_MODEL || 'gemini-1.5-pro', apiVersion: process.env.GEMINI_FALLBACK_API_VERSION || 'v1' }
];
// add some common variants to test
candidates.push({ model: 'gemini-1.5', apiVersion: process.env.GEMINI_API_VERSION || 'v1' });
candidates.push({ model: 'models/gemini-1.5', apiVersion: process.env.GEMINI_API_VERSION || 'v1' });

(async () => {
  for (const c of candidates) {
    try {
      console.log('Testing', c);
      const model = genAI.getGenerativeModel({ model: c.model }, { apiVersion: c.apiVersion });
      const res = await model.generateContent('Say hello');
      const r = await res.response;
      const t = await r.text();
      console.log('SUCCESS', c, t.slice(0,200));
    } catch (err) {
      console.error('ERROR', c, err && err.message ? err.message : err);
      if (err?.response) {
        try {
          const text = await err.response.text();
          console.error('ERR BODY', text.slice(0,1000));
        } catch (e) {}
      }
    }
  }
})();