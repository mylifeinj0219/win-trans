const fs = require('fs');
const os = require('os');
const path = require('path');
const speech = require('@google-cloud/speech');
const { Translate } = require('@google-cloud/translate').v2;
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');

ffmpeg.setFfmpegPath(ffmpegPath);

const keyFilename = path.join(__dirname, 'gcloud-key.json');
const inputPath = path.join(__dirname, 'test-audio.m4a');
const wavPath = path.join(os.tmpdir(), `converted-${Date.now()}.wav`);

const TARGET_SAMPLE_RATE = 16000;

const targets = [
  { code: 'en', name: 'English' },
  { code: 'ja', name: '日本語' },
  { code: 'zh', name: '中文' },
  { code: 'es', name: 'Español' },
  { code: 'fr', name: 'Français' },
];

function convertToWav(input, output) {
  return new Promise((resolve, reject) => {
    ffmpeg(input)
      .audioChannels(1)
      .audioFrequency(TARGET_SAMPLE_RATE)
      .audioCodec('pcm_s16le')
      .format('wav')
      .on('end', resolve)
      .on('error', reject)
      .save(output);
  });
}

async function transcribe() {
  console.log(`오디오 변환 중: ${path.basename(inputPath)} -> WAV (${TARGET_SAMPLE_RATE}Hz, mono, PCM16)`);
  await convertToWav(inputPath, wavPath);
  console.log('변환 완료\n');

  const client = new speech.SpeechClient({ keyFilename });
  const audioBytes = fs.readFileSync(wavPath).toString('base64');

  const request = {
    audio: { content: audioBytes },
    config: {
      encoding: 'LINEAR16',
      sampleRateHertz: TARGET_SAMPLE_RATE,
      audioChannelCount: 1,
      languageCode: 'ko-KR',
    },
  };

  try {
    const [response] = await client.recognize(request);

    if (!response.results || response.results.length === 0) {
      return null;
    }

    return response.results.map((result) => result.alternatives[0].transcript).join('\n');
  } finally {
    fs.unlink(wavPath, () => {});
  }
}

async function translateText(text) {
  const translate = new Translate({ keyFilename });
  const results = [];

  for (const { code, name } of targets) {
    const [translation] = await translate.translate(text, code);
    results.push({ code, name, translation });
  }

  return results;
}

async function main() {
  const transcript = await transcribe();

  if (!transcript) {
    console.log('인식된 텍스트가 없습니다.');
    return;
  }

  console.log('=== 인식 결과 (원문, ko) ===');
  console.log(transcript);
  console.log();

  const translations = await translateText(transcript);

  console.log('=== 번역 결과 ===');
  for (const { code, name, translation } of translations) {
    console.log(`${name} (${code}): ${translation}`);
  }
}

main().catch((err) => {
  console.error('처리 중 오류 발생:', err.message);
  process.exit(1);
});
