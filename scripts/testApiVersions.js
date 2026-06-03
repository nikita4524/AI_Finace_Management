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

const model = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
const apiVersions = ['v1', 'v1beta2', 'v1beta1', 'v1alpha'];

(async () => {
  for (const v of apiVersions) {
    try {
      console.log('Trying', model, 'apiVersion', v);
      const m = genAI.getGenerativeModel({ model }, { apiVersion: v });
      const res = await m.generateContent('Hello');
      const r = await res.response;
      const t = await r.text();
      console.log('SUCCESS', v, t.slice(0,200));
    } catch (err) {
      console.error('ERROR', v, err && err.message ? err.message : err);
    }
  }
})();