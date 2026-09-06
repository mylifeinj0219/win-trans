const fs = require('fs');
const os = require('os');
const path = require('path');
const speech = require('@google-cloud/speech');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');

ffmpeg.setFfmpegPath(ffmpegPath);

const keyFilename = path.join(__dirname, 'gcloud-key.json');
const inputPath = path.join(__dirname, 'test-audio.m4a');
const wavPath = path.join(os.tmpdir(), `converted-${Date.now()}.wav`);

const TARGET_SAMPLE_RATE = 16000;

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

async function main() {
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
      console.log('인식된 텍스트가 없습니다.');
      return;
    }

    const transcription = response.results
      .map((result) => result.alternatives[0].transcript)
      .join('\n');

    console.log('=== 인식 결과 ===');
    console.log(transcription);
  } finally {
    fs.unlink(wavPath, () => {});
  }
}

main().catch((err) => {
  console.error('음성 인식 중 오류 발생:', err.message);
  process.exit(1);
});
