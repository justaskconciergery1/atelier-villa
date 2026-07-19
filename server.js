// Atelier Villa — serveur backend
// Sans dépendance externe : utilise les modules natifs de Node.js 22+ (http, node:sqlite)
// Démarrage : node server.js   (variables d'environnement à définir, voir .env.example)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

// ---------- Chargement du fichier .env (Node ne le fait pas automatiquement) ----------
function loadEnvFile(){
  const envPath = path.join(__dirname, '.env');
  if(!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  content.split('\n').forEach(line=>{
    const trimmed = line.trim();
    if(!trimmed || trimmed.startsWith('#')) return;
    const eqIndex = trimmed.indexOf('=');
    if(eqIndex === -1) return;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))){
      value = value.slice(1, -1);
    }
    if(process.env[key] === undefined) process.env[key] = value;
  });
}
loadEnvFile();

// ---------- Configuration ----------
const PORT = process.env.PORT || 3000;
const APP_USERNAME = process.env.APP_USERNAME || 'admin';
const APP_PASSWORD = process.env.APP_PASSWORD || 'changeme';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.sqlite');

// ---------- Base de données ----------
const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS villas (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);

// ---------- Sessions (en mémoire, simples) ----------
const sessions = new Set();
function newToken(){ return crypto.randomBytes(24).toString('hex'); }
function isAuthed(req){
  const auth = req.headers['authorization'] || '';
  const token = auth.replace('Bearer ', '').trim();
  return token && sessions.has(token);
}

// ---------- Utilitaires HTTP ----------
function sendJSON(res, status, obj){
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

function readBody(req){
  return new Promise((resolve, reject)=>{
    let chunks = [];
    let size = 0;
    req.on('data', c=>{
      size += c.length;
      if(size > 30 * 1024 * 1024){ reject(new Error('Payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', ()=>{
      try{
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch(e){ reject(e); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function serveStatic(req, res){
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = filePath.split('?')[0];
  const fullPath = path.join(__dirname, 'public', filePath);
  if(!fullPath.startsWith(path.join(__dirname, 'public'))){ res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(fullPath, (err, data)=>{
    if(err){ res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(fullPath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------- Serveur ----------
const server = http.createServer(async (req, res)=>{
  // CORS preflight
  if(req.method === 'OPTIONS'){
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end();
    return;
  }

  const url = req.url.split('?')[0];

  try{
    // --- Connexion ---
    if(url === '/api/login' && req.method === 'POST'){
      const body = await readBody(req);
      if(body.username === APP_USERNAME && body.password === APP_PASSWORD){
        const token = newToken();
        sessions.add(token);
        return sendJSON(res, 200, { token });
      }
      return sendJSON(res, 401, { error: 'Identifiants incorrects' });
    }

    // Tout ce qui suit nécessite d'être connecté
    if(url.startsWith('/api/') && !isAuthed(req)){
      return sendJSON(res, 401, { error: 'Non authentifié' });
    }

    // --- Liste des villas (catalogue) ---
    if(url === '/api/villas' && req.method === 'GET'){
      const rows = db.prepare('SELECT id, data, updated_at FROM villas ORDER BY updated_at DESC').all();
      const villas = rows.map(r => ({ id: r.id, updatedAt: r.updated_at, ...JSON.parse(r.data) }));
      return sendJSON(res, 200, { villas });
    }

    // --- Récupérer une villa ---
    const getMatch = url.match(/^\/api\/villas\/([a-zA-Z0-9_\-]+)$/);
    if(getMatch && req.method === 'GET'){
      const row = db.prepare('SELECT data FROM villas WHERE id = ?').get(getMatch[1]);
      if(!row) return sendJSON(res, 404, { error: 'Villa introuvable' });
      return sendJSON(res, 200, { id: getMatch[1], data: JSON.parse(row.data) });
    }

    // --- Créer / mettre à jour une villa ---
    if(url === '/api/villas' && req.method === 'POST'){
      const body = await readBody(req);
      const id = body.id || crypto.randomUUID();
      const now = Date.now();
      const json = JSON.stringify(body.data || {});
      db.prepare(`
        INSERT INTO villas (id, data, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
      `).run(id, json, now);
      return sendJSON(res, 200, { id, updatedAt: now });
    }

    // --- Supprimer une villa ---
    const delMatch = url.match(/^\/api\/villas\/([a-zA-Z0-9_\-]+)$/);
    if(delMatch && req.method === 'DELETE'){
      db.prepare('DELETE FROM villas WHERE id = ?').run(delMatch[1]);
      return sendJSON(res, 200, { ok: true });
    }

    // --- Génération de texte IA (proxy sécurisé vers Anthropic) ---
    if(url === '/api/generate-description' && req.method === 'POST'){
      if(!ANTHROPIC_API_KEY){
        return sendJSON(res, 500, { error: "Clé API Anthropic non configurée côté serveur." });
      }
      const body = await readBody(req);
      const { mediaType, base64Data, prompt } = body;
      if(!mediaType || !base64Data){
        return sendJSON(res, 400, { error: 'Photo manquante.' });
      }
      const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 200,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } },
              { type: 'text', text: prompt || "Write, in English only, one evocative sentence (around 22-28 words) describing this villa room in a high-end real estate brochure style, based on what the photo shows. Reply with the text only, no quotation marks, no preamble." }
            ]
          }]
        })
      });
      const data = await anthropicRes.json();
      if(!anthropicRes.ok){
        return sendJSON(res, anthropicRes.status, { error: data.error ? data.error.message : 'Erreur API Anthropic' });
      }
      const text = (data.content || []).map(b => b.text || '').join('').trim();
      return sendJSON(res, 200, { text });
    }

    // --- Fichiers statiques (le front-end) ---
    if(!url.startsWith('/api/')){
      return serveStatic(req, res);
    }

    sendJSON(res, 404, { error: 'Route inconnue' });
  } catch(err){
    console.error(err);
    sendJSON(res, 500, { error: 'Erreur serveur' });
  }
});

server.listen(PORT, ()=>{
  console.log(`Atelier Villa — serveur démarré sur http://localhost:${PORT}`);
  if(!ANTHROPIC_API_KEY){
    console.log('⚠️  ANTHROPIC_API_KEY non définie : la génération IA sera désactivée.');
  } else {
    console.log('Clé API chargée : ' + ANTHROPIC_API_KEY.slice(0,18) + '...' + ANTHROPIC_API_KEY.slice(-6) + ' (' + ANTHROPIC_API_KEY.length + ' caractères)');
  }
});
