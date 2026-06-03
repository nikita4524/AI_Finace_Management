(async () => {
  try {
    const t = await import('tesseract.js');
    console.log('tesseract.js loaded, keys:', Object.keys(t));
    if (t.createWorker || t.createWorker === undefined) {
      console.log('worker available');
    }
  } catch (e) {
    console.error('failed to load tesseract.js', e);
    process.exit(1);
  }
})();