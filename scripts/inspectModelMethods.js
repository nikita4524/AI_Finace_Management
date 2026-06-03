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

(async () => {
  try {
    const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-1.5-flash' }, { apiVersion: process.env.GEMINI_API_VERSION || 'v1' });
    console.log('instanceKeys', Object.keys(model));
    console.log('protoKeys', Object.getOwnPropertyNames(Object.getPrototypeOf(model)));
  } catch (err) {
    console.error('ERR', err && err.message ? err.message : err);
  }
})();