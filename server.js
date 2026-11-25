import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const MASTER_EMAIL = 'marcelo.afg1@gmail.com';

// Load Firebase configuration
let firebaseConfig = {};
try {
  const cfgRaw = fs.readFileSync(path.join(__dirname, 'firebase-applet-config.json'), 'utf8');
  firebaseConfig = JSON.parse(cfgRaw);
} catch (e) {
  console.warn('Could not load firebase-applet-config.json:', e.message);
}

// Storage for AI configuration
const DATA_DIR = path.join(__dirname, '.data');
const AI_CONFIG_FILE = path.join(DATA_DIR, 'ai-config.json');

function getStoredAiConfig() {
  try {
    if (fs.existsSync(AI_CONFIG_FILE)) {
      const raw = fs.readFileSync(AI_CONFIG_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error('Error reading ai-config.json:', err);
  }
  return { chave: '', ts: 0 };
}

function saveStoredAiConfig(chave) {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    }
    const data = { chave: String(chave || '').trim(), ts: Date.now() };
    fs.writeFileSync(AI_CONFIG_FILE, JSON.stringify(data), { mode: 0o600 });
    return true;
  } catch (err) {
    console.error('Error writing ai-config.json:', err);
    return false;
  }
}

function removeStoredAiConfig() {
  try {
    if (fs.existsSync(AI_CONFIG_FILE)) {
      fs.unlinkSync(AI_CONFIG_FILE);
    }
    return true;
  } catch (err) {
    console.error('Error removing ai-config.json:', err);
    return false;
  }
}

async function saveKeyToFirestore(chave, idToken) {
  try {
    const databaseId = firebaseConfig.firestoreDatabaseId || '(default)';
    const projectId = firebaseConfig.projectId;
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${databaseId}/documents/config/ai`;
    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${idToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        fields: {
          id: { stringValue: 'ai' },
          chave: { stringValue: String(chave).trim() },
          ts: { integerValue: String(Date.now()) }
        }
      })
    });
    return res.ok;
  } catch (err) {
    console.error('saveKeyToFirestore error:', err);
    return false;
  }
}

async function removeKeyFromFirestore(idToken) {
  try {
    const databaseId = firebaseConfig.firestoreDatabaseId || '(default)';
    const projectId = firebaseConfig.projectId;
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${databaseId}/documents/config/ai`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${idToken}`
      }
    });
    return res.ok;
  } catch (err) {
    console.error('removeKeyFromFirestore error:', err);
    return false;
  }
}

async function getKeyFromFirestore(idToken) {
  try {
    const databaseId = firebaseConfig.firestoreDatabaseId || '(default)';
    const projectId = firebaseConfig.projectId;
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${databaseId}/documents/config/ai`;
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${idToken}`
      }
    });
    if (!res.ok) return '';
    const doc = await res.json();
    return doc.fields?.chave?.stringValue || '';
  } catch (err) {
    console.error('getKeyFromFirestore error:', err);
    return '';
  }
}

function detectProvider(key) {
  const k = String(key || '').trim();
  if (/^(AIza|AQ\.)/.test(k)) return 'google';
  if (/^sk-ant-/.test(k)) return 'anthropic';
  return 'deepseek';
}

function getProviderDisplayName(prov) {
  if (prov === 'google') return 'Google Gemini';
  if (prov === 'anthropic') return 'Anthropic Claude';
  if (prov === 'deepseek') return 'DeepSeek';
  return 'Desconhecido';
}

// Verify Firebase Auth ID token
async function verifyAuth(req) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  const idToken = authHeader.slice(7).trim();
  if (!idToken) return null;

  try {
    const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${firebaseConfig.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken })
    });
    if (!res.ok) return null;
    const data = await res.json();
    const user = data.users?.[0];
    if (!user) return null;

    const email = (user.email || '').toLowerCase();
    const emailVerified = !!user.emailVerified;
    const isMaster = email === MASTER_EMAIL && emailVerified;

    return {
      uid: user.localId,
      email,
      emailVerified,
      isMaster,
      idToken
    };
  } catch (err) {
    console.error('verifyAuth error:', err);
    return null;
  }
}

// Check if authenticated user is Master or an approved admin
async function isAuthorizedAdmin(authInfo) {
  if (!authInfo) return false;
  if (authInfo.isMaster) return true;

  try {
    const databaseId = firebaseConfig.firestoreDatabaseId || '(default)';
    const projectId = firebaseConfig.projectId;
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${databaseId}/documents/admins/${authInfo.uid}`;
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${authInfo.idToken}`
      }
    });
    if (!res.ok) return false;
    const doc = await res.json();
    const fields = doc.fields || {};
    const role = fields.role?.stringValue;
    const ativo = fields.ativo ? fields.ativo.booleanValue : true;
    return ativo && ['master', 'admin', 'operador'].includes(role);
  } catch (err) {
    console.error('isAuthorizedAdmin error:', err);
    return false;
  }
}

// Schema conversion for Gemini function calling
function iaSchemaGemini(sc) {
  if (!sc || typeof sc !== 'object') return sc;
  if (Array.isArray(sc)) return sc.map(iaSchemaGemini);
  const o = {};
  for (const k of ['type', 'description', 'format', 'nullable', 'required', 'minItems', 'maxItems', 'minimum', 'maximum']) {
    if (sc[k] !== undefined) o[k] = sc[k];
  }
  if (typeof o.type === 'string') o.type = o.type.toUpperCase();
  if (Array.isArray(sc.enum)) {
    const e = sc.enum.filter(v => v !== '');
    if (e.length) o.enum = e.map(String);
  }
  if (sc.properties) {
    o.properties = {};
    for (const [k, v] of Object.entries(sc.properties)) o.properties[k] = iaSchemaGemini(v);
  }
  if (sc.items) o.items = iaSchemaGemini(sc.items);
  return o;
}

const iaContentParts = c => typeof c === 'string' ? [{ text: c }] : (Array.isArray(c) ? c.map(x => x.type === 'text' ? { text: x.text } : x.type === 'image' ? { inline_data: { mime_type: x.source.media_type, data: x.source.data } } : x.type === 'document' ? { inline_data: { mime_type: x.source.media_type, data: x.source.data } } : { text: String(x.text || '') }) : [{ text: String(c || '') }]);

// Call Google Gemini
async function executeGeminiCall(chave, { texto, pdfs = [], imgs = [], voz = null, modelo = 'gemini-2.5-flash', ferr, sistema }) {
  const t0 = Date.now();
  const parts = [
    ...imgs.map(m => ({ inline_data: { mime_type: 'image/jpeg', data: m.img } })),
    ...pdfs.map(p => ({ inline_data: { mime_type: 'application/pdf', data: p.pdf } })),
    { text: texto || 'Leia o que foi anexado e registre os lançamentos.' }
  ];
  const hist = (voz && voz.hist ? voz.hist : []).map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: iaContentParts(m.content)
  }));
  const body = {
    system_instruction: { parts: [{ text: voz?.sistema || sistema }] },
    contents: [...hist, { role: 'user', parts }],
    tools: [{ function_declarations: [{ name: ferr.name, description: ferr.description, parameters: iaSchemaGemini(ferr.input_schema) }] }],
    tool_config: { function_calling_config: { mode: 'ANY', allowed_function_names: [ferr.name] } },
    generationConfig: { maxOutputTokens: voz ? 2000 : 8000, thinkingConfig: { thinkingBudget: 0 } }
  };

  const ac = new AbortController();
  const tm = setTimeout(() => ac.abort(), (pdfs.length > 0 || imgs.length > 0) ? 60000 : 25000);
  let r;
  try {
    r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': chave.trim()
      },
      body: JSON.stringify(body),
      signal: ac.signal
    });
  } catch (e) {
    clearTimeout(tm);
    const duracaoMs = Date.now() - t0;
    const isTimeout = e && e.name === 'AbortError';
    const err = new Error(isTimeout ? 'A API do Google demorou demais para responder.' : (e?.message || 'Erro de rede ao falar com o Google.'));
    err.status = isTimeout ? 504 : 0;
    err.rawMsg = isTimeout ? 'timeout' : String(e?.message || '');
    err.duracaoMs = duracaoMs;
    throw err;
  }
  clearTimeout(tm);

  const duracaoMs = Date.now() - t0;
  const j = await r.json().catch(() => ({}));
  const ent = j?.usageMetadata?.promptTokenCount || 0, sai = j?.usageMetadata?.candidatesTokenCount || 0;

  if (!r.ok) {
    const m = j?.error?.message || '';
    const msg = r.status === 401 || r.status === 403 || /API key/i.test(m)
      ? 'A chave do Google não foi aceita. O Administrador Master deve conferir em Configurações > Lançar com IA.'
      : r.status === 429
        ? 'Limite do Google atingido. Espere um minuto e tente de novo.'
        : 'A IA não respondeu agora' + (m ? ' (' + m + ')' : '') + '.';
    const err = new Error(msg);
    err.status = r.status;
    err.rawMsg = m;
    err.duracaoMs = duracaoMs;
    err.ent = ent;
    err.sai = sai;
    throw err;
  }

  const fc = (j.candidates?.[0]?.content?.parts || []).find(x => x.functionCall || x.function_call);
  const args = (fc && (fc.functionCall || fc.function_call)?.args) || null;
  if (!args) {
    const err = new Error('A IA não devolveu lançamentos. Tente reescrever o texto.');
    err.status = 200;
    err.rawMsg = 'sem functionCall';
    err.duracaoMs = duracaoMs;
    err.ent = ent;
    err.sai = sai;
    throw err;
  }
  return { args, ent, sai, duracaoMs, api: 'Google Gemini', modelo };
}

// Call Anthropic Claude
async function executeAnthropicCall(chave, { texto, pdfs = [], imgs = [], voz = null, modelo = 'claude-haiku-5-5', ferr, sistema }) {
  const t0 = Date.now();
  const content = [
    ...imgs.map(m => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: m.img } })),
    ...pdfs.map(p => ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: p.pdf } })),
    { type: 'text', text: texto || 'Leia o que foi anexado e registre os lançamentos.' }
  ];
  const ac = new AbortController();
  const tm = setTimeout(() => ac.abort(), (pdfs.length > 0 || imgs.length > 0) ? 60000 : 25000);
  let r;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': chave.trim(),
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: modelo,
        max_tokens: voz ? 4000 : 8000,
        system: voz?.sistema || sistema,
        tools: [ferr],
        tool_choice: { type: 'tool', name: ferr.name },
        messages: [...(voz && voz.hist ? voz.hist : []), { role: 'user', content }]
      }),
      signal: ac.signal
    });
  } catch (e) {
    clearTimeout(tm);
    const duracaoMs = Date.now() - t0, isTimeout = e && e.name === 'AbortError';
    const err = new Error(isTimeout ? 'A API da Anthropic demorou demais para responder.' : (e?.message || 'Erro de rede ao falar com a Anthropic.'));
    err.status = isTimeout ? 504 : 0;
    err.rawMsg = isTimeout ? 'timeout' : String(e?.message || '');
    err.duracaoMs = duracaoMs;
    throw err;
  }
  clearTimeout(tm);

  const duracaoMs = Date.now() - t0;
  const j = await r.json().catch(() => ({}));
  const ent = j.usage?.input_tokens || 0, sai = j.usage?.output_tokens || 0;

  if (!r.ok) {
    const m = j?.error?.message || '';
    const err = new Error(r.status === 401 ? 'A chave da Anthropic não foi aceita. O Administrador Master deve conferir em Configurações > Lançar com IA.' : r.status === 429 ? 'Muitos envios seguidos. Espere um minuto e tente de novo.' : 'A IA não respondeu agora' + (m ? ' (' + m + ')' : '') + '.');
    err.status = r.status;
    err.rawMsg = m;
    err.duracaoMs = duracaoMs;
    err.ent = ent;
    err.sai = sai;
    throw err;
  }

  const tu = (j.content || []).find(c => c.type === 'tool_use');
  if (!tu) {
    const err = new Error('A IA não devolveu lançamentos. Tente reescrever o texto.');
    err.status = 200;
    err.rawMsg = 'sem tool_use';
    err.duracaoMs = duracaoMs;
    err.ent = ent;
    err.sai = sai;
    throw err;
  }
  return { args: tu.input, ent, sai, duracaoMs, api: 'Anthropic Claude', modelo };
}

// Call DeepSeek
async function executeDeepSeekCall(chave, { texto, pdfs = [], imgs = [], voz = null, modelo = 'deepseek-chat', ferr, sistema }) {
  const t0 = Date.now();
  const messages = [{ role: 'system', content: voz?.sistema || sistema }];
  if (voz && voz.hist) {
    for (const m of voz.hist) {
      messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
    }
  }
  const userContent = [];
  for (const img of imgs) {
    userContent.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${img.img}` } });
  }
  for (const _pdf of pdfs) {
    userContent.push({ type: 'text', text: `[Documento PDF anexado]` });
  }
  userContent.push({ type: 'text', text: texto || 'Leia o que foi anexado e registre os lançamentos.' });
  messages.push({ role: 'user', content: userContent });

  const body = {
    model: modelo,
    messages,
    tools: [{
      type: 'function',
      function: {
        name: ferr.name,
        description: ferr.description,
        parameters: ferr.input_schema
      }
    }],
    tool_choice: { type: 'function', function: { name: ferr.name } }
  };

  const ac = new AbortController();
  const tm = setTimeout(() => ac.abort(), 45000);
  let r;
  try {
    r = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + chave.trim()
      },
      body: JSON.stringify(body),
      signal: ac.signal
    });
  } catch (e) {
    clearTimeout(tm);
    const duracaoMs = Date.now() - t0, isTimeout = e && e.name === 'AbortError';
    const err = new Error(isTimeout ? 'A API da DeepSeek demorou demais para responder.' : (e?.message || 'Erro de rede ao falar com a DeepSeek.'));
    err.status = isTimeout ? 504 : 0;
    err.rawMsg = isTimeout ? 'timeout' : String(e?.message || '');
    err.duracaoMs = duracaoMs;
    throw err;
  }
  clearTimeout(tm);

  const duracaoMs = Date.now() - t0;
  const j = await r.json().catch(() => ({}));
  const ent = j.usage?.prompt_tokens || 0, sai = j.usage?.completion_tokens || 0;

  if (!r.ok) {
    const m = j?.error?.message || '';
    const err = new Error(r.status === 401 ? 'A chave da DeepSeek não foi aceita. O Administrador Master deve verificar em Configurações > Lançar com IA.' : r.status === 429 ? 'Limite da DeepSeek atingido. Espere um minuto.' : 'A IA não respondeu agora' + (m ? ' (' + m + ')' : '') + '.');
    err.status = r.status;
    err.rawMsg = m;
    err.duracaoMs = duracaoMs;
    err.ent = ent;
    err.sai = sai;
    throw err;
  }

  const choice = j.choices?.[0];
  const toolCall = choice?.message?.tool_calls?.[0];
  if (!toolCall || !toolCall.function) {
    const err = new Error('A IA não devolveu lançamentos. Tente reescrever o texto.');
    err.status = 200;
    err.rawMsg = 'sem tool_call';
    err.duracaoMs = duracaoMs;
    err.ent = ent;
    err.sai = sai;
    throw err;
  }
  let args = {};
  try { args = JSON.parse(toolCall.function.arguments || '{}'); } catch { args = {}; }
  return { args, ent, sai, duracaoMs, api: 'DeepSeek', modelo };
}

// Parse JSON bodies up to 35MB for images/PDFs
app.use(express.json({ limit: '35mb' }));

// Protect private files and directories from static exposure
app.use((req, res, next) => {
  if (req.path.startsWith('/.') || req.path.includes('.data') || req.path.includes('server.js') || req.path.includes('package.json') || req.path.includes('firestore.rules') || req.path.includes('firebase-blueprint.json')) {
    return res.status(404).send('Not found');
  }
  next();
});

// API Routes
// 1. Get AI status (never reveals the raw key to anyone)
app.get('/api/ia/status', async (req, res) => {
  const authInfo = await verifyAuth(req);
  if (!authInfo) return res.status(401).json({ error: 'Não autenticado' });

  const isAdmin = await isAuthorizedAdmin(authInfo);
  if (!isAdmin) return res.status(403).json({ error: 'Acesso não autorizado' });

  let cfg = getStoredAiConfig();
  // Se for o Master, sincroniza com o Firestore na nuvem
  if (authInfo.isMaster) {
    const firestoreKey = await getKeyFromFirestore(authInfo.idToken);
    if (firestoreKey && firestoreKey !== cfg.chave) {
      saveStoredAiConfig(firestoreKey);
      cfg = { chave: firestoreKey };
    } else if (!firestoreKey && cfg.chave) {
      await saveKeyToFirestore(cfg.chave, authInfo.idToken);
    }
  }

  const hasKey = !!cfg.chave;
  const prov = hasKey ? detectProvider(cfg.chave) : null;

  return res.json({
    configured: hasKey,
    provider: prov,
    providerName: prov ? getProviderDisplayName(prov) : null,
    isMaster: authInfo.isMaster
  });
});

// 2. Save AI key (Master only)
app.post('/api/ia/save-key', async (req, res) => {
  const authInfo = await verifyAuth(req);
  if (!authInfo) return res.status(401).json({ error: 'Não autenticado' });
  if (!authInfo.isMaster) return res.status(403).json({ error: 'Apenas o Administrador Master pode cadastrar ou alterar a chave de IA.' });

  const { chave } = req.body || {};
  if (!chave || typeof chave !== 'string' || !chave.trim()) {
    return res.status(400).json({ error: 'Chave inválida' });
  }

  const cleanKey = chave.trim();
  // 1. Salva no banco de dados Firestore na nuvem (protegido exclusivamente para o Master)
  await saveKeyToFirestore(cleanKey, authInfo.idToken);
  // 2. Salva no arquivo local do servidor
  saveStoredAiConfig(cleanKey);

  const prov = detectProvider(cleanKey);
  return res.json({
    ok: true,
    provider: prov,
    providerName: getProviderDisplayName(prov)
  });
});

// 3. Remove AI key (Master only)
app.post('/api/ia/remove-key', async (req, res) => {
  const authInfo = await verifyAuth(req);
  if (!authInfo) return res.status(401).json({ error: 'Não autenticado' });
  if (!authInfo.isMaster) return res.status(403).json({ error: 'Apenas o Administrador Master pode remover a chave de IA.' });

  // 1. Remove do Firestore
  await removeKeyFromFirestore(authInfo.idToken);
  // 2. Remove do arquivo local
  removeStoredAiConfig();

  return res.json({ ok: true });
});

// 4. Proxy AI calls securely (Any authorized admin can call, key never exposed)
app.post('/api/ia/call', async (req, res) => {
  const authInfo = await verifyAuth(req);
  if (!authInfo) return res.status(401).json({ error: 'Não autenticado' });

  const isAdmin = await isAuthorizedAdmin(authInfo);
  if (!isAdmin) return res.status(403).json({ error: 'Acesso não autorizado à IA' });

  const cfg = getStoredAiConfig();
  if (!cfg.chave) {
    return res.status(400).json({
      error: 'Falta a chave da IA. O Administrador Master deve cadastrar a chave em Configurações > Lançar com IA.'
    });
  }

  const { texto, pdfs = [], imgs = [], voz = null, modelo = null, ferr, sistema } = req.body || {};
  if (!ferr || !ferr.name) {
    return res.status(400).json({ error: 'Estrutura da ferramenta ausente.' });
  }

  const prov = detectProvider(cfg.chave);
  try {
    let result;
    if (prov === 'google') {
      try {
        result = await executeGeminiCall(cfg.chave, { texto, pdfs, imgs, voz, modelo: modelo || 'gemini-2.5-flash', ferr, sistema });
      } catch (err1) {
        if (err1.status === 503 || err1.status === 429 || err1.status === 504 || /high demand|rate limit|resource exhausted|unavailable|overloaded|timeout/i.test(err1.rawMsg || '')) {
          result = await executeGeminiCall(cfg.chave, { texto, pdfs, imgs, voz, modelo: 'gemini-2.5-flash-lite', ferr, sistema });
        } else {
          throw err1;
        }
      }
    } else if (prov === 'anthropic') {
      result = await executeAnthropicCall(cfg.chave, { texto, pdfs, imgs, voz, modelo: modelo || 'claude-haiku-5-5', ferr, sistema });
    } else {
      result = await executeDeepSeekCall(cfg.chave, { texto, pdfs, imgs, voz, modelo: modelo || 'deepseek-chat', ferr, sistema });
    }

    return res.json({
      ok: true,
      provider: prov,
      api: result.api,
      modelo: result.modelo,
      args: result.args,
      ent: result.ent,
      sai: result.sai,
      duracaoMs: result.duracaoMs
    });
  } catch (err) {
    return res.status(err.status && err.status >= 400 && err.status < 600 ? err.status : 500).json({
      ok: false,
      error: err.message || 'Erro ao processar chamada com a IA.',
      rawMsg: err.rawMsg || '',
      duracaoMs: err.duracaoMs || 0,
      ent: err.ent || 0,
      sai: err.sai || 0
    });
  }
});

// Static files
app.use(express.static(__dirname, {
  index: false,
  extensions: ['html'],
  setHeaders(res, filePath) {
    if (filePath.endsWith('.webmanifest')) {
      res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    }
    if (filePath.endsWith('sw.js')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

app.get(['/', '/gestao', '/gestao/*', '/gestao/index.html'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.use((_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`Morangos Made in Roça server listening on http://${HOST}:${PORT}`);
});
