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
const {GoogleGenerativeAI} = require('@google/generative-ai');
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
(async () => {
  try {
    const models = await genAI.listModels?.();
    console.log('===START===');
    console.log(JSON.stringify(models, null, 2));
    console.log('===END===');
  } catch (e) {
    console.error('ERROR', e);
    process.exit(1);
  }
})();
