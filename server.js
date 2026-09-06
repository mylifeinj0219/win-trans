// override: false (기본값)를 명시 — Railway처럼 시스템이 이미 주입한 환경변수가 있으면
// .env 파일 내용으로 덮어쓰지 않고 시스템 값을 그대로 둔다. 로컬에서 .env가 없을 때만 이걸로 채워짐.
require('dotenv').config({ override: false });

console.log('전체 환경변수 개수:', Object.keys(process.env).length);
console.log('SESSION_SECRET 존재 여부:', 'SESSION_SECRET' in process.env);

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const express = require('express');
const expressSession = require('express-session');
const multer = require('multer');
const QRCode = require('qrcode');
const { createCanvas, Image, DOMMatrix } = require('canvas');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

// pdfjs-dist는 브라우저 전역(Image/DOMMatrix 등)이 있다고 가정하고 이미지/패턴을 렌더링하므로 Node에 등록해줌
if (!global.Image) global.Image = Image;
if (!global.DOMMatrix) global.DOMMatrix = DOMMatrix;
const Anthropic = require('@anthropic-ai/sdk');
const WebSocket = require('ws');
const speech = require('@google-cloud/speech');
const { Translate } = require('@google-cloud/translate').v2;

const PORT = process.env.PORT || 3000;

// 우선순위: GOOGLE_CREDENTIALS_JSON 환경변수(Railway 등, 키 파일을 올릴 수 없는 환경)
//        > 로컬 gcloud-key.json 파일
//        > 둘 다 없으면 옵션 없이 생성 — Cloud Run에서는 이 경우 메타데이터 서버를 통해
//          연결된 서비스 계정으로 자동 인증(Application Default Credentials)된다.
function loadGoogleAuthOptions() {
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    // Railway 환경변수 입력창에 붙여넣는 과정에서 private_key의 개행이 깨지는 경우가 있어,
    // 그런 손상을 배포 환경 로그에서 바로 알아챌 수 있도록 형태만 점검(값 자체는 출력하지 않음)
    const pk = credentials.private_key || '';
    console.log('GOOGLE_CREDENTIALS_JSON 사용:', {
      project_id: credentials.project_id || '(없음)',
      client_email: credentials.client_email || '(없음)',
      private_key_looks_valid:
        pk.startsWith('-----BEGIN PRIVATE KEY-----') && pk.trimEnd().endsWith('-----END PRIVATE KEY-----'),
    });
    return { credentials, projectId: credentials.project_id };
  }

  const keyFilename = path.join(__dirname, 'gcloud-key.json');
  if (fs.existsSync(keyFilename)) {
    console.log('gcloud-key.json 파일로 Google Cloud 인증');
    return { keyFilename };
  }

  console.log('GOOGLE_CREDENTIALS_JSON/gcloud-key.json 없음 — Application Default Credentials 사용(Cloud Run 서비스 계정 등)');
  return {};
}

const googleAuthOptions = loadGoogleAuthOptions();

// 로컬(Windows)에서는 정상 동작하는 streamingRecognize가 Railway/Cloud Run(둘 다 Linux 컨테이너)
// 에서만 "12 UNIMPLEMENTED"로 실패하는 상황이라, 코드/설정(request, credentials)은 이미 여러 차례
// 재현 테스트로 검증을 마쳤고 — Node 런타임/의존성 버전이 배포 환경에서 실제로 무엇인지가
// 남은 유력한 변수라 아래에서 확인한다. package-lock.json이 커밋되어 있어 npm ci로 설치되는
// 패키지 버전 자체는 로컬과 동일해야 하지만, 실제 Node.js 버전(Docker 베이스 이미지/Railway
// Nixpacks가 고른 버전)은 다를 수 있다.
function readInstalledVersion(pkgName) {
  try {
    // google-gax처럼 package.json의 "exports"가 하위 경로 require를 막아둔 패키지도 있어,
    // require() 대신 node_modules 안의 package.json을 직접 읽는다.
    const pkgJsonPath = path.join(__dirname, 'node_modules', pkgName, 'package.json');
    return JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')).version;
  } catch (err) {
    return `확인 불가(${err.message})`;
  }
}

console.log('런타임 정보:', {
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  grpcJs: readInstalledVersion('@grpc/grpc-js'),
  googleGax: readInstalledVersion('google-gax'),
});

const translateClient = new Translate(googleAuthOptions);

const anthropicClient = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;
if (!anthropicClient) {
  console.warn(
    '경고: ANTHROPIC_API_KEY가 설정되지 않았습니다. 발표 자료 분석과 문맥 교정 기능은 비활성화되고 원문이 그대로 사용됩니다.'
  );
}

const CLAUDE_MODEL = 'claude-sonnet-5';

// 페이지 UI에 쓰이는 고정 문구 (원문은 한국어, 요청 시 target 언어로 번역됨)
const UI_STRINGS_KO = {
  speakerTitle: '화자용 - 실시간 음성인식',
  listenerTitle: '청취자용 - 실시간 자막',
  langSelectLabel: '언어 선택',
  uiLangSelectLabel: 'UI 언어 선택',
  searchPlaceholder: '언어 검색...',
  noResults: '검색 결과가 없습니다',
  startButton: '녹음 시작',
  stopButton: '녹음 중지',
  statusIdle: '대기 중',
  statusRecording: '녹음 중...',
  statusClosed: '연결이 종료되었습니다.',
  statusConnected: '연결됨',
  statusSelectPrompt: '언어를 선택하면 연결됩니다.',
  errorPrefix: '오류',
  unsupportedBrowser: '이 브라우저는 마이크 녹음을 지원하지 않습니다. Chrome을 사용해주세요.',
  materialUploadLabel: '발표 자료 업로드 (선택, PDF/PPT/텍스트)',
  slidePreviewLabel: '슬라이드 미리보기',
  translationPreviewLabel: '번역 미리보기',
  uploadButton: '업로드 및 분석',
  uploadAnalyzing: '분석 중...',
  uploadDone: '분석 완료',
  uploadNoFile: '파일을 선택해주세요.',
  startSessionButton: '세션 시작',
  endSessionButton: '세션 종료',
  sessionCodeLabel: '세션 코드',
  joinLinkLabel: '참여 링크',
  copyLinkButton: '링크 복사',
  copyDone: '복사됨',
  inviteButton: '초대 메시지 보내기',
  linkCopiedToast: '링크가 복사되었습니다.',
  messageCopiedToast: '초대 메시지가 복사되었습니다.',
  inviteMessageIntro: '실시간 통역 세션에 초대합니다.',
  inviteMessageInstruction: '아래 링크로 접속해서 원하는 언어를 선택해주세요.',
  inviteMessageCodeLabel: '세션 코드',
  inviteMessageStartLabel: '시작 시각',
  inviteMessageNamedSuffix: '세션에 초대합니다.',
  sessionNamePlaceholder: '세션 이름을 입력하세요',
  speakerCardTitle: '언어 및 녹음',
  transcriptCardTitle: '실시간 인식 및 번역',
  shareCardTitle: '참여 안내',
  transcriptPlaceholder: '세션을 시작하면 실시간 인식 결과가 여기에 표시됩니다.',
  previewPlaceholder: '세션을 시작하고 언어를 선택하면 번역 미리보기가 여기에 표시됩니다.',
  slidePlaceholder: '발표 자료를 업로드하면 슬라이드가 여기에 표시됩니다.',
  sharePlaceholderText: '세션을 시작하면 QR코드와 공유 링크가 여기에 표시됩니다.',
  listenerCountLabel: '접속 인원',
  noListeners: '접속한 청취자가 없습니다.',
  sessionRequired: '먼저 세션을 시작해주세요.',
  sessionNotFound: '세션을 찾을 수 없습니다. 코드를 확인해주세요.',
  joinSessionLabel: '세션 코드 입력',
  joinButton: '참가',
  validatingSession: '세션 확인 중...',
  langSelectLabel: '언어 선택',
  joinInstructions: '세션 코드를 입력하고 언어를 선택한 뒤 참가 버튼을 눌러주세요.',
  selectLanguageFirst: '언어를 먼저 선택해주세요.',
  enterSessionCodeFirst: '세션 코드를 입력해주세요.',
  logoutButton: '로그아웃',
};

const UI_KEYS = Object.keys(UI_STRINGS_KO);
const UI_VALUES = Object.values(UI_STRINGS_KO);

const languageListCache = new Map(); // target -> [{code, name}]
const uiStringsCache = new Map(); // target -> {key: translatedText}

async function getLanguageList(target) {
  if (!languageListCache.has(target)) {
    const [languages] = await translateClient.getLanguages(target);
    languages.sort((a, b) => a.name.localeCompare(b.name));
    languageListCache.set(target, languages);
  }
  return languageListCache.get(target);
}

async function getUiStrings(target) {
  if (!uiStringsCache.has(target)) {
    const [translations] = await translateClient.translate(UI_VALUES, target);
    const result = {};
    UI_KEYS.forEach((key, i) => {
      result[key] = translations[i];
    });
    uiStringsCache.set(target, result);
  }
  return uiStringsCache.get(target);
}

const SLIDE_RENDER_SCALE = 1.5;

// pdfjs-dist가 Node 환경에서 렌더링에 쓸 캔버스를 만들도록 요구하는 표준 팩토리 (공식 Node 예제 패턴)
class NodeCanvasFactory {
  create(width, height) {
    const canvas = createCanvas(width, height);
    return { canvas, context: canvas.getContext('2d') };
  }
  reset(canvasAndContext, width, height) {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }
  destroy(canvasAndContext) {
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

// PDF를 한 번만 파싱해서 분석용 텍스트와 슬라이드 미리보기 이미지를 함께 뽑아냄
async function extractPdfTextAndSlides(pdfPath) {
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const canvasFactory = new NodeCanvasFactory();
  const pdf = await pdfjsLib.getDocument({ data, canvasFactory }).promise;

  const textParts = [];
  const slideImageBuffers = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);

    const textContent = await page.getTextContent();
    textParts.push(textContent.items.map((item) => item.str).join(' '));

    const viewport = page.getViewport({ scale: SLIDE_RENDER_SCALE });
    const canvasAndContext = canvasFactory.create(viewport.width, viewport.height);
    await page.render({
      canvasContext: canvasAndContext.context,
      viewport,
      canvasFactory,
    }).promise;
    slideImageBuffers.push(canvasAndContext.canvas.toBuffer('image/png'));
    canvasFactory.destroy(canvasAndContext);
  }

  return { text: textParts.join('\n'), slideImageBuffers };
}

function findSofficePath() {
  const candidates = [
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    '/usr/bin/soffice',
    '/usr/bin/libreoffice',
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'soffice'; // PATH에 등록되어 있을 경우를 위한 최후 시도
}

function convertToPdf(inputPath, outDir) {
  return new Promise((resolve, reject) => {
    const sofficePath = findSofficePath();
    execFile(
      sofficePath,
      ['--headless', '--convert-to', 'pdf', '--outdir', outDir, inputPath],
      { timeout: 120000 },
      (err) => {
        if (err) {
          reject(
            new Error(
              `LibreOffice(soffice) 변환 실패: ${err.message}. LibreOffice가 설치되어 있는지 확인해주세요.`
            )
          );
          return;
        }
        const base = path.basename(inputPath, path.extname(inputPath));
        const pdfPath = path.join(outDir, `${base}.pdf`);
        if (!fs.existsSync(pdfPath)) {
          reject(new Error('PDF 변환 결과 파일을 찾을 수 없습니다.'));
          return;
        }
        resolve(pdfPath);
      }
    );
  });
}

// 업로드된 파일(txt/pdf/pptx)에서 분석용 텍스트와 슬라이드 미리보기 이미지를 함께 준비
async function prepareMaterial(file) {
  const ext = path.extname(file.originalname).toLowerCase();

  if (ext === '.txt') {
    return { text: file.buffer.toString('utf-8'), slideImageBuffers: [] };
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'material-'));
  try {
    let pdfPath;

    if (ext === '.pdf') {
      pdfPath = path.join(workDir, 'input.pdf');
      fs.writeFileSync(pdfPath, file.buffer);
    } else if (ext === '.pptx' || ext === '.ppt') {
      const inputPath = path.join(workDir, `input${ext}`);
      fs.writeFileSync(inputPath, file.buffer);
      pdfPath = await convertToPdf(inputPath, workDir);
    } else {
      throw new Error('지원하지 않는 파일 형식입니다.');
    }

    return await extractPdfTextAndSlides(pdfPath);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

const MAX_MATERIAL_CHARS = 40000; // Claude 프롬프트 비용/속도를 위한 원문 길이 상한

async function analyzeMaterialText(text) {
  if (!anthropicClient) {
    return { terms: [], summary: '' };
  }

  const truncated = text.slice(0, MAX_MATERIAL_CHARS);

  const prompt = `다음은 발표 자료 원문입니다. 아래 JSON 형식으로만 답변하세요 (설명이나 마크다운 코드블록 없이 순수 JSON만):

{"terms": ["용어1", "용어2"], "summary": "발표 내용 요약"}

요구사항:
- terms: 발음이 애매하거나 음성인식이 놓치기 쉬운 핵심 용어/고유명사 위주로 20~30개 이내의 배열
- summary: 발표 전체 맥락을 파악할 수 있도록 5~10문장으로 요약한 문자열

--- 발표 자료 원문 ---
${truncated}`;

  const message = await anthropicClient.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = message.content[0].text.trim();
  const jsonText = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const parsed = JSON.parse(jsonText);

  return {
    terms: Array.isArray(parsed.terms) ? parsed.terms.slice(0, 30) : [],
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
  };
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const name = file.originalname.toLowerCase();
    const isPdf = file.mimetype === 'application/pdf' || name.endsWith('.pdf');
    const isText = file.mimetype === 'text/plain' || name.endsWith('.txt');
    const isPptx =
      name.endsWith('.pptx') ||
      name.endsWith('.ppt') ||
      file.mimetype === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
      file.mimetype === 'application/vnd.ms-powerpoint';

    if (!isPdf && !isText && !isPptx) {
      cb(new Error('PDF, PPT/PPTX, 또는 텍스트(.txt) 파일만 업로드할 수 있습니다.'));
      return;
    }
    cb(null, true);
  },
});

// ===== 세션 관리 =====
// 화자 1명 : 청취자 N명 구조의 "세션"을 코드 단위로 격리해 여러 발표가 동시에 열릴 수 있게 함
const sessions = new Map(); // code -> session

// 0/O, 1/I처럼 헷갈리는 문자는 제외
const SESSION_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateSessionCode() {
  let code;
  do {
    code = Array.from(
      { length: 6 },
      () => SESSION_CODE_CHARS[crypto.randomInt(SESSION_CODE_CHARS.length)]
    ).join('');
  } while (sessions.has(code));
  return code;
}

function createSession(code) {
  return {
    code,
    speakerWs: null,
    recognizeStream: null,
    listeners: new Map(), // ws -> lang
    presentationContext: null, // { fileName, terms, summary, analyzedAt }
    slideImages: [], // Buffer[] (PNG), 화자 화면 전용 슬라이드 미리보기
    previewLang: null, // 화자 화면의 번역 미리보기 언어
    createdAt: Date.now(),
  };
}

function getSessionListenerStats(session) {
  const byLang = {};
  for (const lang of session.listeners.values()) {
    byLang[lang] = (byLang[lang] || 0) + 1;
  }
  return { total: session.listeners.size, byLang };
}

function broadcastListenerStats(session) {
  if (!session.speakerWs || session.speakerWs.readyState !== WebSocket.OPEN) return;
  session.speakerWs.send(
    JSON.stringify({ type: 'listenerStats', ...getSessionListenerStats(session) })
  );
}

function endSession(session) {
  if (session.recognizeStream) {
    session.recognizeStream.clearInterimTimer();
    session.recognizeStream.end();
    session.recognizeStream = null;
  }
  if (session.speakerWs && session.speakerWs.readyState === WebSocket.OPEN) {
    session.speakerWs.close();
  }
  for (const listenerWs of session.listeners.keys()) {
    if (listenerWs.readyState === WebSocket.OPEN) {
      listenerWs.send(JSON.stringify({ type: 'sessionEnded' }));
      listenerWs.close();
    }
  }
  session.listeners.clear();
  sessions.delete(session.code);
  console.log(`세션 종료: ${session.code}`);
}

const app = express();
app.use(express.json());

console.log(
  'SESSION_SECRET 값 확인:',
  process.env.SESSION_SECRET
    ? '값 있음 (길이: ' + process.env.SESSION_SECRET.length + ')'
    : '값 없음(undefined)'
);

app.use(
  expressSession({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax' },
  })
);

// speaker.html은 로그인 세션이 없으면 정적 파일 서빙 전에 로그인 화면으로 돌려보냄
app.get('/speaker.html', (req, res, next) => {
  if (req.session && req.session.authenticated) {
    next();
    return;
  }
  res.redirect('/speaker-login.html');
});

app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/login', (req, res) => {
  const { username, password, remember } = req.body || {};
  if (username === process.env.SPEAKER_USERNAME && password === process.env.SPEAKER_PASSWORD) {
    req.session.authenticated = true;
    // '로그인 상태 유지' 체크 시에만 쿠키 만료 기간을 지정 (아니면 브라우저 종료 시 만료되는 세션 쿠키 유지)
    if (remember) req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;
    res.json({ ok: true });
    return;
  }
  res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get('/api/languages', async (req, res) => {
  const target = req.query.target || 'en';
  try {
    res.json(await getLanguageList(target));
  } catch (err) {
    console.error('언어 목록 조회 오류:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ui-strings', async (req, res) => {
  const target = req.query.target || 'en';
  try {
    res.json(await getUiStrings(target));
  } catch (err) {
    console.error('UI 문자열 번역 오류:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sessions', async (req, res) => {
  const code = generateSessionCode();
  sessions.set(code, createSession(code));

  const joinUrl = `${req.protocol}://${req.get('host')}/listener.html?session=${code}`;

  try {
    const qrCodeDataUrl = await QRCode.toDataURL(joinUrl, { margin: 1, width: 240 });
    console.log(`세션 생성: ${code}`);
    res.json({ code, joinUrl, qrCodeDataUrl });
  } catch (err) {
    console.error('QR 코드 생성 오류:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sessions/:code', (req, res) => {
  const session = sessions.get(req.params.code.toUpperCase());
  if (!session) {
    res.status(404).json({ error: '세션을 찾을 수 없습니다.' });
    return;
  }
  res.json({ code: session.code, ...getSessionListenerStats(session) });
});

app.delete('/api/sessions/:code', (req, res) => {
  const session = sessions.get(req.params.code.toUpperCase());
  if (!session) {
    res.status(404).json({ error: '세션을 찾을 수 없습니다.' });
    return;
  }
  endSession(session);
  res.json({ ok: true });
});

app.post('/api/sessions/:code/upload-material', upload.single('file'), async (req, res) => {
  const session = sessions.get(req.params.code.toUpperCase());
  if (!session) {
    res.status(404).json({ error: '세션을 찾을 수 없습니다.' });
    return;
  }
  if (!req.file) {
    res.status(400).json({ error: '파일이 없습니다.' });
    return;
  }

  // multer(busboy)는 멀티파트 파일명을 latin1로 디코딩하므로 UTF-8 파일명(한글 등)이 깨져서 들어옴 -> 원래 바이트로 되돌려 UTF-8로 재해석
  const originalFileName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');

  try {
    const { text, slideImageBuffers } = await prepareMaterial(req.file);
    const { terms, summary } = await analyzeMaterialText(text);

    session.presentationContext = {
      fileName: originalFileName,
      terms,
      summary,
      analyzedAt: Date.now(),
    };
    session.slideImages = slideImageBuffers;

    console.log(
      `발표 자료 분석 완료 [${session.code}]: ${originalFileName} (용어 ${terms.length}개, 슬라이드 ${slideImageBuffers.length}장${anthropicClient ? '' : ', ANTHROPIC_API_KEY 미설정으로 분석 생략됨'})`
    );

    res.json({
      fileName: session.presentationContext.fileName,
      termCount: terms.length,
      terms,
      summary,
      slideCount: slideImageBuffers.length,
    });
  } catch (err) {
    console.error('발표 자료 분석 오류:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sessions/:code/slides/:index', (req, res) => {
  const session = sessions.get(req.params.code.toUpperCase());
  if (!session) {
    res.status(404).end();
    return;
  }

  const index = parseInt(req.params.index, 10);
  const buffer = session.slideImages[index - 1];
  if (!buffer) {
    res.status(404).end();
    return;
  }

  res.type('png').send(buffer);
});

// multer/기타 라우트 오류를 JSON으로 응답
app.use((err, req, res, next) => {
  console.error('요청 처리 오류:', err.message);
  res.status(400).json({ error: err.message });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const STT_LANGUAGE_CODE = 'ko-KR';
const INTERIM_TRANSLATE_DEBOUNCE_MS = 250;
const EARLY_FINAL_DEBOUNCE_MS = 200;
const RECENT_CONTEXT_SIZE = 4; // 교정 프롬프트에 포함할 최근 확정 문장 개수 (3~4개)
const SPEECH_CONTEXT_BOOST = 15;

// 한국어 문장 종결 어미 패턴 (조기 확정 감지용, ko-KR에서만 사용)
const KOREAN_SENTENCE_END_REGEX = /(습니다|입니다|합니다|네요|군요|죠|까|다|요)[.!?~,]*\s*$/;

// STT 확정 결과를 발표 요약 + 최근 문맥을 참고해 자연스럽게 교정
async function correctTranscript(rawText, recentSentences, presentationContext) {
  if (!anthropicClient || !rawText.trim()) return rawText;

  const contextParts = [];
  if (presentationContext && presentationContext.summary) {
    contextParts.push(`[발표 요약]\n${presentationContext.summary}`);
  }
  if (presentationContext && presentationContext.terms.length > 0) {
    contextParts.push(`[핵심 용어 목록]\n${presentationContext.terms.join(', ')}`);
  }
  if (recentSentences.length > 0) {
    contextParts.push(`[최근 대화 맥락]\n${recentSentences.join('\n')}`);
  }

  const prompt = `${contextParts.join('\n\n')}

[새 문장]
${rawText}

위 맥락을 참고해서, 새 문장에서 문맥상 이상한 단어나 발음 오인식이 있으면 자연스럽게 교정해줘. 의미가 명확하면 그대로 둬. 의미를 바꾸거나 내용을 추가/삭제하지 말고, 교정된 문장만 출력해줘 (설명이나 따옴표 없이).`;

  try {
    const message = await anthropicClient.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });
    const corrected = message.content[0].text.trim();
    return corrected || rawText;
  } catch (err) {
    console.error('문맥 교정 오류:', err.message);
    return rawText;
  }
}

function startRecognizeStream(ws, session) {
  const client = new speech.SpeechClient(googleAuthOptions);

  let interimTimer = null; // 잠정 번역 표시용 디바운스 (기존 기능)
  let earlyFinalTimer = null; // 한국어 문장 종결 어미 감지 후 조기 확정용 디바운스
  let confirmedPrefix = ''; // 현재 STT 세그먼트 내에서 이미 확정 처리된 앞부분
  const recentSentences = []; // 문맥 교정용 최근 확정 문장 (세션 단위로 유지)

  const speechConfig = {
    encoding: 'WEBM_OPUS',
    sampleRateHertz: 48000,
    languageCode: STT_LANGUAGE_CODE,
  };

  // 발표 자료에서 추출한 핵심 용어를 STT 힌트로 등록해 인식 정확도를 높임
  if (session.presentationContext && session.presentationContext.terms.length > 0) {
    speechConfig.speechContexts = [
      { phrases: session.presentationContext.terms, boost: SPEECH_CONTEXT_BOOST },
    ];
  }

  const request = {
    config: speechConfig,
    interimResults: true,
  };

  function clearInterimTimer() {
    if (interimTimer) {
      clearTimeout(interimTimer);
      interimTimer = null;
    }
  }

  function clearEarlyFinalTimer() {
    if (earlyFinalTimer) {
      clearTimeout(earlyFinalTimer);
      earlyFinalTimer = null;
    }
  }

  // 이미 확정된 앞부분을 제외한, 아직 확정되지 않은 나머지 텍스트
  function getRemainder(transcript) {
    return transcript.startsWith(confirmedPrefix) ? transcript.slice(confirmedPrefix.length) : transcript;
  }

  // remainder를 확정 처리: 문맥 교정 후 화자에게는 확정(검은 글씨)으로, 청취자에게는 확정 번역으로 전송
  // resetSegment=true면 다음 STT 세그먼트가 완전히 새로 시작된다고 보고 확정 기준을 초기화 (Google의 실제 isFinal)
  // resetSegment=false면 같은 세그먼트가 계속 이어지는 것으로 보고 지금까지 나온 전체 텍스트를 기준점으로 남겨둠 (조기 확정)
  async function commitFinal(remainder, fullTranscript, resetSegment) {
    clearInterimTimer();
    clearEarlyFinalTimer();
    confirmedPrefix = resetSegment ? '' : fullTranscript;

    if (!remainder) return;

    const corrected = await correctTranscript(remainder, recentSentences, session.presentationContext);
    recentSentences.push(corrected);
    if (recentSentences.length > RECENT_CONTEXT_SIZE) recentSentences.shift();

    const lineId = crypto.randomUUID();

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'transcript', isFinal: true, transcript: corrected, lineId }));
    }

    broadcastToListeners(session, corrected, true, lineId).catch((err) => {
      console.error('번역 오류:', err.message);
    });
  }

  const stream = client
    .streamingRecognize(request)
    .on('error', (err) => {
      console.error('STT 스트림 오류:', err.message);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
      }
    })
    .on('data', (data) => {
      const result = data.results && data.results[0];
      if (!result || !result.alternatives || !result.alternatives[0]) return;

      const fullTranscript = result.alternatives[0].transcript;

      if (!result.isFinal) {
        const remainder = getRemainder(fullTranscript);

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'transcript', isFinal: false, transcript: remainder }));
        }

        // 잠정 번역 표시 디바운스 (기존 기능, remainder 기준으로 동작)
        clearInterimTimer();
        interimTimer = setTimeout(() => {
          interimTimer = null;
          if (remainder) {
            broadcastToListeners(session, remainder, false).catch((err) => {
              console.error('잠정 번역 오류:', err.message);
            });
          }
        }, INTERIM_TRANSLATE_DEBOUNCE_MS);

        // 한국어 문장 종결 어미 감지 -> 조기 확정 디바운스
        if (STT_LANGUAGE_CODE === 'ko-KR') {
          if (KOREAN_SENTENCE_END_REGEX.test(remainder.trim())) {
            clearEarlyFinalTimer();
            earlyFinalTimer = setTimeout(() => {
              earlyFinalTimer = null;
              commitFinal(remainder, fullTranscript, false).catch((err) => {
                console.error('조기 확정 처리 오류:', err.message);
              });
            }, EARLY_FINAL_DEBOUNCE_MS);
          } else {
            // 어미 패턴이 사라졌다는 것은 문장이 계속 이어진다는 뜻 -> 대기 중이던 조기 확정 취소
            clearEarlyFinalTimer();
          }
        }
        return;
      }

      // Google이 보낸 실제 확정 결과 -> 세그먼트를 완전히 종료 처리
      const remainder = getRemainder(fullTranscript);
      commitFinal(remainder, fullTranscript, true).catch((err) => {
        console.error('확정 처리 오류:', err.message);
      });
    });

  stream.clearInterimTimer = () => {
    clearInterimTimer();
    clearEarlyFinalTimer();
  };

  return stream;
}

// 청취자들의 자막 언어 + 화자의 번역 미리보기 언어를 한 번에 모아 번역하고 각자에게 배분
// lineId가 있으면(확정 문장) 클라이언트가 같은 줄을 다시 찾아 자리 유지 교체를 할 수 있도록 함께 실어 보냄
// (최초 확정 방송과, 화자가 원문을 수정한 뒤의 재번역 방송 모두 이 함수를 재사용)
async function broadcastToListeners(session, transcript, isFinal, lineId) {
  const targetLangs = new Set(session.listeners.values());
  if (session.previewLang) targetLangs.add(session.previewLang);
  if (targetLangs.size === 0) return;

  const entries = await Promise.all(
    Array.from(targetLangs).map(async (lang) => {
      const [translation] = await translateClient.translate(transcript, lang);
      return [lang, translation];
    })
  );
  const translationByLang = new Map(entries);

  for (const [listenerWs, lang] of session.listeners.entries()) {
    if (listenerWs.readyState !== WebSocket.OPEN) continue;

    const translation = translationByLang.get(lang);
    if (translation === undefined) continue;

    listenerWs.send(JSON.stringify({ type: 'subtitle', isFinal, transcript, translation, lang, lineId }));
  }

  if (session.previewLang && session.speakerWs && session.speakerWs.readyState === WebSocket.OPEN) {
    const translation = translationByLang.get(session.previewLang);
    if (translation !== undefined) {
      session.speakerWs.send(
        JSON.stringify({
          type: 'previewTranslation',
          isFinal,
          transcript,
          translation,
          lang: session.previewLang,
          lineId,
        })
      );
    }
  }
}

wss.on('connection', (ws, req) => {
  const { searchParams } = new URL(req.url, `http://${req.headers.host}`);
  const role = searchParams.get('role');
  const sessionCode = (searchParams.get('session') || '').toUpperCase();
  const session = sessions.get(sessionCode);

  if (!session) {
    console.log(`존재하지 않는 세션(${sessionCode})으로 연결 시도, 연결을 종료합니다.`);
    ws.send(JSON.stringify({ type: 'error', message: '세션을 찾을 수 없습니다.' }));
    ws.close();
    return;
  }

  if (role === 'speaker') {
    console.log(`화자 연결됨 [${session.code}]`);

    if (session.speakerWs && session.speakerWs.readyState === WebSocket.OPEN) {
      console.log('기존 화자 연결을 종료하고 새 연결로 교체합니다.');
      session.speakerWs.close();
    }

    session.speakerWs = ws;
    session.recognizeStream = startRecognizeStream(ws, session);
    broadcastListenerStats(session); // 재연결 시 현재 접속 인원을 바로 보여줌

    ws.on('message', (message, isBinary) => {
      if (isBinary) {
        if (session.recognizeStream && !session.recognizeStream.destroyed && session.recognizeStream.writable) {
          session.recognizeStream.write(message);
        }
        return;
      }

      // 오디오가 아닌 텍스트 프레임은 화자 화면에서 보내는 제어 메시지 (예: 번역 미리보기 언어 변경, 확정 문장 수정)
      try {
        const data = JSON.parse(message.toString());

        if (data.type === 'setPreviewLang') {
          session.previewLang = data.lang || null;
          return;
        }

        if (data.type === 'editTranscript' && data.lineId) {
          const edited = typeof data.transcript === 'string' ? data.transcript.trim() : '';
          if (!edited) return;
          // 화자가 3초 내에 직접 고친 원문을 다시 번역해서, 이미 나간 자막/미리보기를 같은 lineId로 교체
          broadcastToListeners(session, edited, true, data.lineId).catch((err) => {
            console.error('수정 재번역 오류:', err.message);
          });
        }
      } catch (err) {
        console.error('화자 제어 메시지 처리 오류:', err.message);
      }
    });

    ws.on('close', () => {
      console.log(`화자 연결 종료 [${session.code}]`);
      if (session.recognizeStream) {
        session.recognizeStream.clearInterimTimer();
        session.recognizeStream.end();
        session.recognizeStream = null;
      }
      if (session.speakerWs === ws) session.speakerWs = null;
    });
  } else if (role === 'listener') {
    const lang = searchParams.get('lang') || 'en';
    console.log(`청취자 연결됨 [${session.code}] (lang=${lang})`);
    session.listeners.set(ws, lang);
    broadcastListenerStats(session);

    ws.on('close', () => {
      console.log(`청취자 연결 종료 [${session.code}]`);
      session.listeners.delete(ws);
      broadcastListenerStats(session);
    });
  } else {
    console.log('알 수 없는 역할로 연결 시도, 연결을 종료합니다.');
    ws.close();
  }
});

server.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
  console.log(`  화자용:   http://localhost:${PORT}/speaker.html`);
  console.log(`  청취자용: http://localhost:${PORT}/listener.html`);
});
