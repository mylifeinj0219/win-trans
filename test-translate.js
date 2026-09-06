const { Translate } = require('@google-cloud/translate').v2;
const path = require('path');

const translate = new Translate({
  keyFilename: path.join(__dirname, 'gcloud-key.json'),
});

const text = '안녕하세요, 발표를 시작하겠습니다';

const targets = [
  { code: 'en', name: 'English' },
  { code: 'ja', name: '日本語' },
  { code: 'zh', name: '中文' },
  { code: 'es', name: 'Español' },
  { code: 'fr', name: 'Français' },
];

async function main() {
  console.log(`원문(ko): ${text}\n`);

  for (const { code, name } of targets) {
    const [translation] = await translate.translate(text, code);
    console.log(`${name} (${code}): ${translation}`);
  }
}

main().catch((err) => {
  console.error('번역 중 오류 발생:', err.message);
  process.exit(1);
});
