/* Abdulrahman Saad Motion: Abdulrahman Saad's Claude panel for After Effects (his brand identity: warm ink + gold, Thmanyah).
 * - Chat with Claude from inside AE. Runs Claude Code headless (`claude -p`) on the user's own Claude login. No API key.
 * - A tiny local MCP server (127.0.0.1 + random token) gives Claude six tools, executed inside AE through CEP evalScript:
 *   run_extendscript, snapshot_frame, preview_sheet (many frames on one contact sheet = how Claude sees the motion),
 *   read_animation (learn an animation from the selected layers), save_to_skill and listen_timeline (the comp's speech
 *   as words with their frames, through Whisper on this computer, for captions).
 * - Reference images (button, Ctrl+V, drag & drop) are saved in <working folder>/References and opened by Claude.
 * - Claude works from one working folder: its memory and its skill (<folder>/.claude/skills/<name>) live there, and every
 *   other skill is switched off for the panel's runs, so it follows only what the user taught it.
 * Windows and macOS.
 */
(function () {
  'use strict';

  const nodeRequire = (window.cep_node && window.cep_node.require) || window.require;
  const fs = nodeRequire('fs'), path = nodeRequire('path'), os = nodeRequire('os');
  const http = nodeRequire('http'), https = nodeRequire('https'), crypto = nodeRequire('crypto'), cp = nodeRequire('child_process');
  const NodeBuffer = nodeRequire('buffer').Buffer;
  const IS_WIN = process.platform === 'win32';

  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function readJSON(s) { try { return JSON.parse(s) || {}; } catch (e) { return {}; } }

  // ------------------------------------------------------------------ ExtendScript bridge
  function evalES(script) { return new Promise((res) => window.__adobe_cep__.evalScript(script, res)); }
  // JSON string literal with every non-ASCII char escaped, so it is a valid ES3 string literal.
  function esString(s) { return JSON.stringify(String(s)).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')); }
  const esJSON = (v) => JSON.stringify(v).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  // "file:///C:/..." on Windows, "file:///Users/..." on macOS
  function extensionPath() { return decodeURI(window.__adobe_cep__.getSystemPath('extension')).replace(IS_WIN ? /^file:\/{3}/ : /^file:\/\//, ''); }
  async function loadHost() {
    const host = path.join(extensionPath(), 'host', 'host.jsx').replace(/\\/g, '/');
    return evalES('$.evalFile(' + esString(host) + ')');
  }

  // ------------------------------------------------------------------ settings
  // local-config.json next to the panel (not shipped): this PC's default working folder, and the work folders whose
  // Claude memory the panel must never share or write (protectMemoryOf)
  const LOCAL = readJSON((() => { try { return fs.readFileSync(path.join(extensionPath(), 'local-config.json'), 'utf8').replace(/^﻿/, ''); } catch (e) { return ''; } })());
  const DEFAULT_CWD = LOCAL.cwd || path.join(os.homedir(), 'Documents', 'Abdulrahman Saad Motion');
  // thinking level: X-High by default (best work); the user can lower it from the ⚡ menu to save time and limits
  const settings = Object.assign({ cwd: DEFAULT_CWD, model: '', skillPath: '', effort: 'xhigh' }, readJSON(localStorage.getItem('asMotion.settings')));
  let sessionId = localStorage.getItem('asMotion.session') || null;
  function saveSettings() { localStorage.setItem('asMotion.settings', JSON.stringify(settings)); }
  function setSession(id) { sessionId = id; if (id) localStorage.setItem('asMotion.session', id); else localStorage.removeItem('asMotion.session'); }
  // ------------------------------------------------------------------ safety: the panel never writes the user's own skills or any other memory
  // Claude Code keeps each folder's memory in ~/.claude/projects/<folder path, every non-letter/digit as "-">/memory,
  // so two Arabic folder names of the same length share one memory: such a folder is refused too.
  const projectKey = (dir) => path.resolve(dir).replace(/[^a-zA-Z0-9]/g, '-');
  const PROTECTED_KEYS = (LOCAL.protectMemoryOf || []).map(projectKey);
  const samePath = (a, b) => path.relative(path.resolve(a), path.resolve(b)) === '';
  function isInside(p, dir) { const r = path.relative(path.resolve(dir), path.resolve(p)); return !!r && !r.startsWith('..') && !path.isAbsolute(r); }
  function cwdProblem(dir) {
    const home = os.homedir(), dotClaude = path.join(home, '.claude');
    if (!dir) return 'اختار فولدر شغل.';
    if (samePath(dir, home) || samePath(dir, dotClaude) || isInside(dir, dotClaude))
      return 'فولدر الشغل ماينفعش يكون فولدر اليوزر نفسه أو جوه .claude (علشان السكيلز والميموري بتاعتك تفضل في أمان). اختار فولدر تاني.';
    if (PROTECTED_KEYS.indexOf(projectKey(dir)) >= 0) return 'الفولدر ده بيشارك نفس ميموري شغلك الأساسي، فالبانل مش هتشتغل منه. اختار فولدر تاني باسم إنجليزي.';
    return '';
  }
  function ensureCwd() { if (cwdProblem(settings.cwd)) return false; try { fs.mkdirSync(settings.cwd, { recursive: true }); return true; } catch (e) { return false; } }

  // ------------------------------------------------------------------ skills: the one linked to the panel
  // Added skills (zip / folder) and new ones go to <working folder>/.claude/skills; skills already in ~/.claude/skills
  // can be linked where they are. lib/skillpack.js reads and writes the .zip packages.
  const pack = nodeRequire(path.join(extensionPath(), 'lib', 'skillpack.js'));
  const projectSkillsDir = () => path.join(settings.cwd, '.claude', 'skills');
  const userSkillsDir = () => path.join(os.homedir(), '.claude', 'skills');
  function skillAt(dir) {
    const file = path.join(dir, 'SKILL.md');
    if (!fs.existsSync(file)) return null;
    let name = '';
    try { name = pack.frontmatterName(fs.readFileSync(file, 'utf8')); } catch (e) {}
    return { dir: path.basename(dir), name: name || path.basename(dir), path: dir };
  }
  function skillsIn(base) {
    let names = [];
    try { names = fs.readdirSync(base); } catch (e) { return []; }
    return names.map((d) => skillAt(path.join(base, d))).filter(Boolean);
  }
  if (settings.skill && !settings.skillPath) settings.skillPath = path.join(projectSkillsDir(), settings.skill);   // first version kept a folder name
  delete settings.skill;
  function linkedSkill() { return settings.skillPath ? skillAt(settings.skillPath) : null; }
  // skills the working folder switches off (skillOverrides in its .claude/settings.json) are not offered in the list
  function folderOffSkills() { try { return readJSON(fs.readFileSync(path.join(settings.cwd, '.claude', 'settings.json'), 'utf8')).skillOverrides || {}; } catch (e) { return {}; } }
  // every other skill on this computer is off for the panel's runs (skillOverrides), by folder name and by its own name
  function otherSkillsOff() {
    const me = linkedSkill(), off = {};
    for (const s of skillsIn(userSkillsDir()).concat(skillsIn(projectSkillsDir()))) {
      if (me && s.path === me.path) continue;
      for (const n of [s.dir, s.name]) if (!me || (n !== me.dir && n !== me.name)) off[n] = 'off';
    }
    return off;
  }
  function createSkill(raw) {
    const name = pack.safeName(raw);
    if (!name) throw new Error('اكتب اسم بالإنجليزي (حروف وأرقام وشرطة)، زي my-motion');
    const dir = path.join(projectSkillsDir(), name), file = path.join(dir, 'SKILL.md');
    if (fs.existsSync(file)) return dir;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, '---\nname: ' + name + '\ndescription: The motion-design playbook the user teaches inside After Effects (graphs, scene transitions, overlapping moves, text animations, design rules). Use it for every animation, scene, transition or text-animation task.\n---\n\n# ' + name + '\n\nEverything in this skill was taught by the user. Follow it exactly.\n');
    return dir;
  }
  function renderSkillPill() {
    const s = linkedSkill();
    $('skillName').textContent = s ? s.dir : 'مفيش سكيل';
    $('skillPill').classList.toggle('none', !s);
  }

  // ------------------------------------------------------------------ tools exposed to Claude
  const TOOLS = [
    {
      name: 'run_extendscript',
      description: 'Run ExtendScript (ES3) inside the open After Effects project as ONE undo group. Returns the value of the last expression, or the error message and line. Helpers available: asmComp(name), asmEase(prop, keyIndex, [x1,y1,x2,y2]), asmEaseAll(prop, [x1,y1,x2,y2]), asmFindEffect(/name/i), asmBrand (Abdulrahman Saad brand colors as [r,g,b], ease, name, role, handle), asmBrandFont("sans"|"serif"|"camel", 400|500|700) -> PostScript name, asmFindFont(/pattern/i), JSON.',
      inputSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'One short line in the user\'s language saying what the script does. Shown in the panel.' },
          code: { type: 'string', description: 'The ExtendScript to run.' }
        },
        required: ['summary', 'code']
      }
    },
    {
      name: 'snapshot_frame',
      description: 'Render one frame of a composition and return it as an image, to check your work visually.',
      inputSchema: {
        type: 'object',
        properties: {
          comp_name: { type: 'string', description: 'Composition name. Omit for the active composition.' },
          time: { type: 'number', description: 'Time in seconds. Omit for the current time indicator.' }
        }
      }
    },
    {
      name: 'preview_sheet',
      description: 'See the MOTION, not one frame: renders several frames of a comp and returns them as ONE contact-sheet image with the frame number on each cell. Use it on every entrance, every scene and EVERY transition (a few frames before, at and after each cut or move: a mid-transition frame must not be empty or show elements colliding), and before telling the user anything is done. The user sees the sheet in the panel too.',
      inputSchema: {
        type: 'object',
        properties: {
          comp_name: { type: 'string', description: 'Composition name. Omit for the active composition.' },
          frames: { type: 'array', items: { type: 'number' }, description: 'Frame numbers to show (max 40). Omit to sample evenly with from/to/count.' },
          from: { type: 'number', description: 'First frame when sampling evenly (default 0).' },
          to: { type: 'number', description: 'Last frame when sampling evenly (default the last frame).' },
          count: { type: 'integer', description: 'How many frames when sampling evenly (default 12, max 40).' },
          columns: { type: 'integer', description: 'Cells per row (default up to 6).' },
          title: { type: 'string', description: 'Short caption in the user\'s language, shown under the sheet.' }
        }
      }
    },
    {
      name: 'read_animation',
      description: 'Read what the user built by hand in After Effects, to learn it: a text animation, a scene, a camera rig, their way of building. Returns the comp settings and each layer in timeline order: index, type, parent, 3D, in/out frames, null / adjustment, precomp source, blending mode, track matte, effects; every animated property with its keyframes [frame, value], the graph of each segment (AE influence/speed and the same graph as cubic-bezier [x1,y1,x2,y2]) and expressions; the static values of transforms, camera options, effects and text animators; text settings. Reads the named layers, else the selected ones, else every layer of the comp. A precomp is listed by its name: read it with comp_name to go inside. A very long reading is saved to a file and you get a layer map plus the file path.',
      inputSchema: {
        type: 'object',
        properties: {
          comp_name: { type: 'string', description: 'Composition name. Omit for the active composition.' },
          layer_names: { type: 'array', items: { type: 'string' }, description: 'Layer names. Omit to read the selected layers, or every layer when none is selected.' },
          all_layers: { type: 'boolean', description: 'true = every layer of the comp even when some are selected (when the user talks about the whole comp, their layers, their order or their way of building).' }
        }
      }
    },
    {
      name: 'save_to_skill',
      description: 'Save what the user teaches (a graph, a scene transition, an overlapping rule, a text animation, a design rule, a correction) into the skill linked to this panel. Saved directly; the previous version of the file is kept in .history. mode "append" adds text at the end of the file (or after the line containing after_text); mode "replace" swaps one exact existing passage (find) for text. Near-copies of something already saved are refused, so the skill never holds the same lesson twice.',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Path inside the skill: "SKILL.md" or a topic file such as "references/graphs.md", "references/transitions.md", "references/text-animations.md", "references/rules.md".' },
          mode: { type: 'string', enum: ['append', 'replace'] },
          text: { type: 'string', description: 'The new text (Markdown), with every number needed to rebuild it exactly.' },
          find: { type: 'string', description: 'replace: the exact existing passage to replace (must appear once).' },
          after_text: { type: 'string', description: 'append: insert after the line that contains this text (optional; default = end of file).' },
          is_new_after_check: { type: 'boolean', description: 'Only after the tool refused a near-copy AND you compared it and the lesson is genuinely different.' },
          summary: { type: 'string', description: 'One short line in the user\'s language: what you are saving. Shown in the panel.' }
        },
        required: ['file', 'mode', 'text', 'summary']
      }
    },
    {
      name: 'listen_timeline',
      description: 'Hear the speech in a composition: renders the comp\'s audio and runs Whisper on this computer (offline). Returns every spoken word with its comp time and frame, grouped in phrases. Use it before captions or any animation that must land on a spoken word. The very first use may download Whisper (about 560 MB, once).',
      inputSchema: {
        type: 'object',
        properties: {
          comp_name: { type: 'string', description: 'Composition name. Omit for the active composition.' },
          from: { type: 'number', description: 'Start time in seconds (optional).' },
          to: { type: 'number', description: 'End time in seconds (optional).' },
          language: { type: 'string', description: 'Spoken language: "ar" (default), "en", or "auto".' },
          hint: { type: 'string', description: 'Optional names or terms likely in the speech, to help the spelling.' }
        }
      }
    }
  ];
  const toolOk = (text) => ({ content: [{ type: 'text', text: String(text) }] });
  const toolErr = (text) => ({ content: [{ type: 'text', text: String(text) }], isError: true });

  async function callTool(name, args) {
    args = args || {};
    if (name === 'run_extendscript') {
      if (typeof args.code !== 'string' || !args.code.trim()) return toolErr('Missing "code".');
      const chip = activity(args.summary || 'بيشغّل سكريبت');
      const out = await evalES('asmRun(' + esString(args.code) + ')');
      let r; try { r = JSON.parse(out); } catch (e) { chip.fail('رد غير متوقع'); return toolErr('ExtendScript returned: ' + out); }
      if (r.ok) chip.done(); else chip.fail(r.error);
      return r.ok ? toolOk(r.result) : toolErr(r.error + (r.line ? ' (line ' + r.line + ')' : ''));
    }
    if (name === 'snapshot_frame') return snapshot(args);
    if (name === 'preview_sheet') return previewSheet(args);
    if (name === 'read_animation') return readAnimation(args);
    if (name === 'save_to_skill') return saveToSkill(args);
    if (name === 'listen_timeline') return listenTimeline(args);
    return toolErr('Unknown tool: ' + name);
  }

  // ------------------------------------------------------------------ listening: comp audio -> 16 kHz mono -> Whisper (this computer) -> words with frames
  // Whisper = the official whisper.cpp build + the light model large-v3-turbo (q5_0, ~550 MB). The installer puts them in
  // WHISPER_DIR; when they are missing (installer skipped or cut off) the panel downloads them itself the first time.
  const WHISPER_DIR = LOCAL.whisperDir || (IS_WIN ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Abdulrahman Saad Motion', 'whisper')
    : path.join(os.homedir(), 'Library', 'Application Support', 'Abdulrahman Saad Motion', 'whisper'));
  const WHISPER_MODEL = path.join(WHISPER_DIR, 'ggml-large-v3-turbo-q5_0.bin');
  const WHISPER_MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin';
  const WHISPER_WIN_URL = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip';
  function whisperExe() {
    const list = IS_WIN ? [path.join(WHISPER_DIR, 'cuda', 'Release', 'whisper-cli.exe'), path.join(WHISPER_DIR, 'bin', 'whisper-cli.exe')]
      : [path.join(WHISPER_DIR, 'bin', 'whisper-cli'), '/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli', '/opt/homebrew/bin/whisper-cpp', '/usr/local/bin/whisper-cpp'];
    return list.find((f) => fs.existsSync(f)) || null;
  }
  // a file over https (redirects followed), streamed to disk with progress
  function download(url, file, onProgress, redirects) {
    redirects = redirects === undefined ? 6 : redirects;
    return new Promise((resolve, reject) => {
      const req = https.get(url, { headers: { 'User-Agent': 'AbdulrahmanSaadMotion' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) { res.resume(); return resolve(download(new URL(res.headers.location, url).toString(), file, onProgress, redirects - 1)); }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' for ' + url)); }
        const total = Number(res.headers['content-length']) || 0, out = fs.createWriteStream(file);
        let got = 0, last = 0;
        res.on('data', (c) => { got += c.length; const now = Date.now(); if (onProgress && now - last > 700) { last = now; onProgress(got, total); } });
        res.on('error', reject); out.on('error', reject);
        out.on('finish', () => resolve(got));
        res.pipe(out);
      });
      req.on('error', reject);
      req.setTimeout(60000, () => req.destroy(new Error('timeout')));
    });
  }
  // null when Whisper is ready, else the reason (downloads what is missing; one download at a time)
  let whisperJob = null;
  function ensureWhisper(chip) {
    if (whisperExe() && fs.existsSync(WHISPER_MODEL)) return Promise.resolve(null);
    if (!whisperJob) whisperJob = (async () => {
      fs.mkdirSync(WHISPER_DIR, { recursive: true });
      const mb = (n) => Math.round(n / 1048576);
      if (!whisperExe()) {
        if (!IS_WIN) return 'Whisper (whisper-cli) is not installed on this Mac. Tell the user to run «Install - Mac.command» again: it installs it with Homebrew.';
        chip.update('🎧 بينزّل برنامج السمع (Whisper)… مرة واحدة بس');
        const zip = path.join(WHISPER_DIR, 'whisper-bin-x64.zip.part');
        await download(WHISPER_WIN_URL, zip);
        const bin = path.join(WHISPER_DIR, 'bin'); fs.mkdirSync(bin, { recursive: true });
        for (const e of pack.readZip(fs.readFileSync(zip))) { const n = e.name.split('/').pop(); if (/^(whisper-cli\.exe|.+\.dll)$/i.test(n)) fs.writeFileSync(path.join(bin, n), e.data); }
        try { fs.unlinkSync(zip); } catch (e) {}
      }
      if (!fs.existsSync(WHISPER_MODEL)) {
        const part = WHISPER_MODEL + '.part';                                           // a cut download never looks finished
        await download(WHISPER_MODEL_URL, part, (got, total) => chip.update('🎧 بينزّل موديل السمع: ' + mb(got) + ' من ' + (total ? mb(total) : '~550') + ' ميجا… (مرة واحدة بس)'));
        fs.renameSync(part, WHISPER_MODEL);
      }
      return null;
    })().catch((e) => 'Could not download Whisper: ' + e.message + '. Check the internet connection and try again.').finally(() => { whisperJob = null; });
    return whisperJob;
  }
  function ext80(b, o) {                                                                // IEEE 80-bit extended (AIFF sample rate)
    const exp = b.readUInt16BE(o) & 0x7fff, hi = b.readUInt32BE(o + 2), lo = b.readUInt32BE(o + 6);
    if (!exp && !hi && !lo) return 0; return hi * Math.pow(2, exp - 16383 - 31) + lo * Math.pow(2, exp - 16383 - 63);
  }
  function readPcmMono(file) {                                                          // WAV or AIFF/AIFC -> { mono Float32Array, rate }
    const b = fs.readFileSync(file), id = b.toString('ascii', 0, 4);
    let ch, rate, bits, off, len, le, flt;
    if (id === 'RIFF') {
      let o = 12, fmt = null, data = null;
      while (o + 8 <= b.length) { const cid = b.toString('ascii', o, o + 4), sz = b.readUInt32LE(o + 4), body = o + 8;
        if (cid === 'fmt ') fmt = { tag: b.readUInt16LE(body), ch: b.readUInt16LE(body + 2), rate: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
        else if (cid === 'data') data = { off: body, len: Math.min(sz, b.length - body) };
        o = body + sz + (sz & 1); }
      if (!fmt || !data) throw new Error('could not read the WAV the render produced');
      ch = fmt.ch; rate = fmt.rate; bits = fmt.bits; off = data.off; len = data.len; le = true; flt = fmt.tag === 3 || (fmt.tag === 0xfffe && bits === 32);
    } else if (id === 'FORM') {
      const kind = b.toString('ascii', 8, 12); let o = 12, comm = null, ssnd = null; le = false; flt = false;
      while (o + 8 <= b.length) { const cid = b.toString('ascii', o, o + 4), sz = b.readUInt32BE(o + 4), body = o + 8;
        if (cid === 'COMM') { comm = { ch: b.readUInt16BE(body), bits: b.readUInt16BE(body + 6), rate: ext80(b, body + 8) };
          if (kind === 'AIFC') { const ct = b.toString('ascii', body + 18, body + 22).toLowerCase(); le = ct === 'sowt'; flt = ct === 'fl32'; } }
        else if (cid === 'SSND') { const pad = b.readUInt32BE(body); ssnd = { off: body + 8 + pad, len: Math.min(sz - 8 - pad, b.length - body - 8 - pad) }; }
        o = body + sz + (sz & 1); }
      if (!comm || !ssnd) throw new Error('could not read the AIFF the render produced');
      ch = comm.ch; rate = comm.rate; bits = comm.bits; off = ssnd.off; len = ssnd.len;
    } else throw new Error('unknown audio file type: ' + id);
    const bps = bits / 8, n = Math.floor(len / (bps * ch)), mono = new Float32Array(n);
    const rd = flt ? (p) => (le ? b.readFloatLE(p) : b.readFloatBE(p))
      : bps === 2 ? (p) => (le ? b.readInt16LE(p) : b.readInt16BE(p)) / 32768
      : bps === 3 ? (p) => (le ? b.readIntLE(p, 3) : b.readIntBE(p, 3)) / 8388608
      : bps === 4 ? (p) => (le ? b.readInt32LE(p) : b.readInt32BE(p)) / 2147483648
      : (p) => (b[p] - 128) / 128;
    for (let i = 0; i < n; i++) { let s = 0; for (let c = 0; c < ch; c++) s += rd(off + (i * ch + c) * bps); mono[i] = s / ch; }
    return { mono, rate };
  }
  function wav16k(mono, rate) {                                                         // float32 mono -> 16 kHz mono PCM16 WAV
    const n = mono.length, ratio = rate / 16000, len = Math.floor(n / ratio), pcm = new Int16Array(len);
    for (let i = 0; i < len; i++) {                                                     // box-average resample
      const a = Math.floor(i * ratio), b = Math.min(n, Math.floor((i + 1) * ratio)); let s = 0; for (let k = a; k < b; k++) s += mono[k];
      const v = Math.max(-1, Math.min(1, s / Math.max(1, b - a))); pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    const buf = NodeBuffer.alloc(44 + pcm.length * 2);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + pcm.length * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(16000, 24);
    buf.writeUInt32LE(32000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(pcm.length * 2, 40);
    for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i], 44 + i * 2);
    return { buf, seconds: len / 16000 };
  }
  async function listenTimeline(args) {
    const chip = activity('🎧 بيجهّز السمع…');
    const missing = await ensureWhisper(chip);
    if (missing) { chip.fail('السمع مش جاهز'); return toolErr(missing); }
    let ci; try { ci = JSON.parse(await evalES('asmCompInfo(' + esString(args.comp_name || '') + ')')); } catch (e) { ci = { ok: false, error: 'unexpected reply from After Effects' }; }
    if (!ci.ok) { chip.fail(ci.error); return toolErr(ci.error); }
    chip.update('🎧 بيسمع صوت «' + ci.name + '»…');
    const base = path.join(os.tmpdir(), 'as-motion-listen-' + Date.now());
    const t0 = typeof args.from === 'number' ? Math.max(0, args.from) : null, dur = typeof args.to === 'number' ? Math.max(0.1, args.to - (t0 || 0)) : null;
    let r;
    try { r = JSON.parse(await evalES('asmAudioRender(' + esString(ci.name) + ',' + esString(base.replace(/\\/g, '/')) + ',' + (t0 === null ? 'null' : t0) + ',' + (dur === null ? 'null' : dur) + ')')); }
    catch (e) { r = { ok: false, error: 'unexpected reply from After Effects' }; }
    if (!r.ok) { chip.fail(r.error || 'failed'); return toolErr('Audio render failed: ' + (r.error || JSON.stringify(r))); }
    let pcm; try { pcm = readPcmMono(r.path); } catch (e) { chip.fail(e.message); return toolErr(e.message + ' (' + r.path + ')'); }
    try { fs.unlinkSync(r.path); } catch (e) {}
    let peak = 0; for (let i = 0; i < pcm.mono.length; i += 7) peak = Math.max(peak, Math.abs(pcm.mono[i]));
    if (peak < 0.002) { chip.fail('مفيش صوت'); return toolOk('The comp "' + ci.name + '" is silent in that range (no audio layers, or they are muted).'); }
    const { buf, seconds } = wav16k(pcm.mono, pcm.rate), wav = base + '.wav'; fs.writeFileSync(wav, buf);
    chip.update('🎧 بيحوّل الكلام لكلمات بتوقيتها… (' + seconds.toFixed(0) + ' ث صوت)');
    const exe = whisperExe(), threads = String(Math.max(2, Math.min(12, os.cpus().length - 1)));
    const lang = args.language || 'ar', prompt = (lang === 'ar' ? 'كلام بالعربي المصري.' : '') + (args.hint ? ' ' + args.hint : '');
    const wargs = ['-m', WHISPER_MODEL, '-f', wav, '-l', lang, '-t', threads, '-np', '-ojf', '-of', base, '-ml', '1', '-sow'];
    if (prompt.trim()) wargs.push('--prompt', prompt.trim());
    const code = await new Promise((res) => { const p = cp.spawn(exe, wargs, { cwd: path.dirname(exe), windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] }); p.on('error', () => res(-1)); p.on('close', res); });
    let j = null; try { j = JSON.parse(fs.readFileSync(base + '.json', 'utf8')); } catch (e) {}
    try { fs.unlinkSync(wav); fs.unlinkSync(base + '.json'); } catch (e) {}
    if (!j || !j.transcription) { chip.fail('Whisper وقف'); return toolErr('Whisper failed (exit ' + code + ').'); }
    const start = r.start || 0, fps = ci.fps;
    const words = j.transcription.map((s) => ({ w: String(s.text || '').trim(), a: start + s.offsets.from / 1000, b: start + s.offsets.to / 1000 }))
      .filter((x) => x.w && !/^\[.*\]$/.test(x.w)).map((x) => ({ w: x.w, start: +x.a.toFixed(3), end: +x.b.toFixed(3), frame: Math.round(x.a * fps), endFrame: Math.round(x.b * fps) }));
    if (!words.length) { chip.done('🎧 مفيش كلام واضح'); return toolOk('Whisper heard no words in "' + ci.name + '".'); }
    // phrases: a pause over 0.3 s starts a new one, so Claude reads the speech like a script
    const lines = []; let cur = [];
    words.forEach((x, i) => { if (cur.length && x.start - words[i - 1].end > 0.3) { lines.push(cur); cur = []; } cur.push(x); }); if (cur.length) lines.push(cur);
    const dir = path.join(settings.cwd, '.claude', 'listen'); fs.mkdirSync(dir, { recursive: true });
    const saved = path.join(dir, ci.name.replace(/[\\/:*?"<>|]+/g, '_') + '.json');
    fs.writeFileSync(saved, JSON.stringify({ comp: ci.name, fps, from: start, heardAt: new Date().toISOString(), words }, null, 1));
    chip.done('🎧 سمع ' + words.length + ' كلمة في «' + ci.name + '»');
    const fmt = (x) => x.start.toFixed(2) + 's f' + x.frame + ' ' + x.w;
    return toolOk('Speech in "' + ci.name + '" (' + fps + ' fps), comp time, ' + words.length + ' words. Each word: start seconds, start frame, word.\n' +
      lines.map((l) => '[' + l[0].start.toFixed(2) + '–' + l[l.length - 1].end.toFixed(2) + 's  f' + l[0].frame + '–f' + l[l.length - 1].endFrame + '] ' + l.map((x) => x.w).join(' ') + '\n   ' + l.map(fmt).join(' · ')).join('\n') +
      '\nSaved: ' + saved + '\nWhisper may misspell some words: correct them from the context (and from what the user says).');
  }

  // ------------------------------------------------------------------ snapshot: one frame -> JPEG for Claude (and a thumbnail in the chat)
  // AE writes the PNG asynchronously and can pause mid-write: wait until the file ends with its IEND chunk.
  function pngComplete(file) {
    let fd = null;
    try {
      const size = fs.statSync(file).size; if (size < 60) return false;
      const b = NodeBuffer.alloc(12); fd = fs.openSync(file, 'r'); fs.readSync(fd, b, 0, 12, size - 12);
      return b.toString('latin1', 4, 8) === 'IEND';
    } catch (e) { return false; } finally { if (fd !== null) try { fs.closeSync(fd); } catch (e) {} }
  }
  async function waitStable(file, ms) {
    for (let t = 0; t < (ms || 120000); t += 100) { await sleep(100); if (pngComplete(file)) { await sleep(50); return true; } }
    return false;
  }
  async function pngToJpeg(pngPath, max) {
    const buf = fs.readFileSync(pngPath);
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('could not read the frame PNG')); img.src = 'data:image/png;base64,' + buf.toString('base64'); });
    const s = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.width * s)); c.height = Math.max(1, Math.round(img.height * s));
    const g = c.getContext('2d');
    g.fillStyle = '#241D13'; g.fillRect(0, 0, c.width, c.height);   // transparent areas -> brand dark-2
    g.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.85);
  }
  async function snapshot(args) {
    const chip = activity('📸 بيبص على الكادر…');
    const png = path.join(os.tmpdir(), 'as-motion-frame-' + Date.now() + '.png');
    const t = (typeof args.time === 'number') ? String(args.time) : 'null';
    const bpc = Number(await evalES('asmBpc(0)'));
    if (bpc === 32) await evalES('asmBpc(8)');                                           // 32-bpc projects save almost black PNGs
    let r;
    try {
      try { r = JSON.parse(await evalES('asmSnapshot(' + esString(args.comp_name || '') + ',' + t + ',' + esString(png.replace(/\\/g, '/')) + ')')); }
      catch (e) { r = { ok: false, error: 'unexpected reply from After Effects' }; }
      if (r.ok && !(await waitStable(png))) r = { ok: false, error: 'Frame render timed out.' };
    } finally { if (bpc === 32) await evalES('asmBpc(32)'); }
    if (!r.ok) { chip.fail(r.error); return toolErr(r.error); }
    const dataUrl = await pngToJpeg(png, 1024);
    try { fs.unlinkSync(png); } catch (e) {}
    chip.done('📸 ' + r.comp + ' @ ' + Number(r.time).toFixed(2) + 's');
    showImage(dataUrl);
    return { content: [
      { type: 'text', text: 'Frame of "' + r.comp + '" at ' + r.time + 's (' + r.width + 'x' + r.height + '):' },
      { type: 'image', data: dataUrl.split(',')[1], mimeType: 'image/jpeg' }
    ] };
  }

  // ------------------------------------------------------------------ contact sheet: many frames on one image = how Claude sees the motion
  function loadImage(buf) {
    return new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = () => rej(new Error('bad frame image')); img.src = 'data:image/png;base64,' + buf.toString('base64'); });
  }
  async function frameImage(comp, seconds) {
    const png = path.join(os.tmpdir(), 'as-motion-sheet-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) + '.png');
    const r = JSON.parse(await evalES('asmSnapshot(' + esString(comp) + ',' + seconds + ',' + esString(png.replace(/\\/g, '/')) + ')'));
    if (!r.ok) throw new Error(r.error);
    if (!(await waitStable(png))) throw new Error('frame render timed out');
    const img = await loadImage(fs.readFileSync(png));
    try { fs.unlinkSync(png); } catch (e) {}
    return img;
  }
  async function previewSheet(args) {
    let ci; try { ci = JSON.parse(await evalES('asmCompInfo(' + esString(args.comp_name || '') + ')')); } catch (e) { ci = { ok: false, error: 'unexpected reply from After Effects' }; }
    if (!ci.ok) return toolErr(ci.error);
    let frames = Array.isArray(args.frames) && args.frames.length ? args.frames.map(Number).filter((v) => isFinite(v)).map(Math.round) : null;
    if (!frames) {
      const a = Math.max(0, Number(args.from) || 0), b = Math.min(ci.frames - 1, args.to != null ? Number(args.to) : ci.frames - 1);
      const n = Math.max(1, Math.min(40, Number(args.count) || 12));
      frames = []; for (let i = 0; i < n; i++) frames.push(Math.round(a + (b - a) * (n === 1 ? 0 : i / (n - 1))));
    }
    frames = frames.filter((f) => f >= 0 && f < ci.frames + 2).slice(0, 40);
    if (!frames.length) return toolErr('No frames inside the comp (it has ' + ci.frames + ' frames).');
    const cols = Math.max(1, Math.min(frames.length, Number(args.columns) || Math.min(6, frames.length))), rows = Math.ceil(frames.length / cols), lab = 22;
    let cw = Math.floor(Math.min(ci.w / 2, 1800 / cols)), ch = Math.round(cw * ci.h / ci.w);
    const fit = Math.min(1, 1800 / (rows * (ch + lab))); cw = Math.floor(cw * fit); ch = Math.round(cw * ci.h / ci.w);
    const chip = activity('🎞️ بيطلّع شيت ' + frames.length + ' فريم من «' + ci.name + '»…');
    const c = document.createElement('canvas'); c.width = cols * cw; c.height = rows * (ch + lab);
    const g = c.getContext('2d'); g.fillStyle = '#1A150D'; g.fillRect(0, 0, c.width, c.height);
    const bpc = Number(await evalES('asmBpc(0)'));
    if (bpc === 32) await evalES('asmBpc(8)');                                           // 32-bpc projects save almost black PNGs
    try {
      for (let i = 0; i < frames.length; i++) {
        const img = await frameImage(ci.name, frames[i] / ci.fps);
        const x = (i % cols) * cw, y = Math.floor(i / cols) * (ch + lab);
        g.drawImage(img, x, y + lab, cw, ch);
        g.fillStyle = '#D4AF6A'; g.font = '500 14px "Thmanyah Sans", sans-serif'; g.fillText('f' + frames[i] + '  ' + (frames[i] / ci.fps).toFixed(2) + 's', x + 4, y + 16);
      }
    } catch (e) { chip.fail(e.message); return toolErr('Contact sheet failed: ' + e.message); }
    finally { if (bpc === 32) await evalES('asmBpc(32)'); }
    const url = c.toDataURL('image/jpeg', 0.85);
    chip.done('🎞️ شيت ' + frames.length + ' فريم من «' + ci.name + '»');
    showImage(url, args.title || '');
    return { content: [
      { type: 'text', text: 'Contact sheet of "' + ci.name + '" (' + ci.w + 'x' + ci.h + ', ' + ci.fps + ' fps, ' + ci.frames + ' frames). Cells left to right, top to bottom: f' + frames.join(', f') + '.' },
      { type: 'image', data: url.split(',')[1], mimeType: 'image/jpeg' }
    ] };
  }

  // ------------------------------------------------------------------ learning: read an animation, save it to the skill
  async function readAnimation(args) {
    const chip = activity('🎓 بيقرا الأنيميشن…');
    const names = Array.isArray(args.layer_names) ? args.layer_names.map(String) : [];
    const out = await evalES('asmReadAnimation(' + esString(args.comp_name || '') + ',' + esJSON(names) + ',' + (args.all_layers ? 'true' : 'false') + ')');
    let r; try { r = JSON.parse(out); } catch (e) { chip.fail('رد غير متوقع'); return toolErr('ExtendScript returned: ' + out); }
    if (!r.ok) { chip.fail(r.error); return toolErr(r.error); }
    chip.done('🎓 قرا ' + r.layers.length + ' لاير من «' + r.comp + '»');
    const full = JSON.stringify(r);
    if (full.length <= 30000) return toolOk(full);
    // a whole comp can be too long for one reply: the full reading goes to a file, Claude gets a map of the layers
    const dir = path.join(settings.cwd, '.claude', 'learn'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, r.comp.replace(/[\\/:*?"<>|]+/g, '_') + '.json');
    fs.writeFileSync(file, JSON.stringify(r, null, 1));
    const map = r.layers.map((l) => {
      const m = { index: l.index, name: l.name, type: l.type, parent: l.parent, threeD: l.threeD, inFrame: l.inFrame, outFrame: l.outFrame };
      for (const k of ['isNull', 'adjustment', 'precomp', 'blend', 'trackMatte', 'hidden']) if (l[k]) m[k] = l[k];
      m.animated = l.props.filter((p) => p.keys || p.expression).map((p) => p.path.split('/').pop() + (p.keys ? ' f' + p.keys[0][0] + '-f' + p.keys[p.keys.length - 1][0] : ' (expression)'));
      return m;
    });
    return toolOk('The full reading (every key, graph and value) is too long for one reply, so it is saved in ' + file +
      ' (pretty-printed JSON: open it with the Read tool, in parts, for the layers you need). Layer map in timeline order:\n' + JSON.stringify(Object.assign({}, r, { layers: map })));
  }

  // No duplicates: before writing, every paragraph of every .md in the skill is compared with the new text (shared
  // meaningful words). Exact or near copies are refused and the existing passage is returned, so Claude says
  // "already saved" or replaces that passage with a corrected version.
  const SKILL_STOP = new Set('the and for with from that this these those into onto over under then than when what which while also only just same each every his her him its are was were has have had not but all any one two can will would should could more most very much such like used use uses using new now added adds add user claude skill file files video videos make made'.split(' '));
  const wordsOf = (s) => new Set(String(s).toLowerCase().replace(/[`*_#>|()[\]{}"'.,:;!?\-–—→=/\\%×+]+/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !SKILL_STOP.has(w) && !/^\d+$/.test(w)));
  // comparable blocks: each top-level bullet (with its sub-lines) and each short heading section
  function skillBlocks(body) {
    const lines = body.replace(/\r\n/g, '\n').split('\n'), out = []; let sec = [], bul = null;
    const endB = () => { if (bul) out.push(bul.join('\n')); bul = null; };
    const endS = () => { if (sec.length && wordsOf(sec.join(' ')).size <= 120) out.push(sec.join('\n')); sec = []; };
    for (const l of lines) {
      if (/^#+ /.test(l)) { endB(); endS(); sec = [l]; continue; }
      sec.push(l);
      if (/^[-*] |^\d+\. /.test(l)) { endB(); bul = [l]; } else if (bul && /^\s+\S/.test(l)) bul.push(l); else if (!l.trim()) endB();
    }
    endB(); endS();
    return out;
  }
  function similarPassages(base, text) {
    const nw = wordsOf(text); if (nw.size < 4) return [];
    const hits = [];
    (function walk(d) {
      for (const n of fs.readdirSync(d)) {
        if (n === '.history') continue;
        const p = path.join(d, n);
        if (fs.statSync(p).isDirectory()) { walk(p); continue; }
        if (!/\.md$/i.test(n)) continue;
        for (const b of skillBlocks(fs.readFileSync(p, 'utf8'))) {
          const pw = wordsOf(b); if (pw.size < 4) continue;
          let common = 0; for (const w of nw) if (pw.has(w)) common++;
          const score = common / nw.size;                                                   // how much of the new lesson is already there
          if (score >= 0.6) hits.push({ file: path.relative(base, p).replace(/\\/g, '/'), score, text: b.trim().slice(0, 500) });
        }
      }
    })(base);
    return hits.sort((a, b) => b.score - a.score).slice(0, 3);
  }
  async function saveToSkill(args) {
    const skill = linkedSkill();
    if (!skill) return toolErr('No skill is linked to the panel yet. Tell the user to open the panel settings (gear icon) and pick or create a skill, then try again.');
    // the panel only ever writes skills inside <working folder>/.claude/skills (a skill of the computer is used as a copy)
    if (cwdProblem(settings.cwd) || !isInside(skill.path, projectSkillsDir())) return toolErr('Not saved: the linked skill is outside the working folder, and the panel only writes skills inside <working folder>/.claude/skills. Tell the user to link the skill again from the panel settings (it makes a copy).');
    const base = skill.path;
    const rel = String(args.file || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const p = path.resolve(base, rel);
    if (!p.startsWith(base + path.sep) || !/\.md$/i.test(p) || /[\\/]\.history[\\/]/.test(p)) return toolErr('Only .md files inside the linked skill folder.');
    const text = String(args.text || '').replace(/\r\n/g, '\n');
    if (!text.trim()) return toolErr('Missing "text".');
    const old = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    if (old.replace(/\s+/g, ' ').includes(text.replace(/\s+/g, ' ').trim())) {
      activity('📘 محفوظة قبل كده في السكيل: ' + rel).done();
      return toolErr('Already in ' + rel + ' word for word: nothing saved. Tell the user it was already saved there.');
    }
    if (!args.is_new_after_check && !(args.mode === 'replace' && args.find)) {
      const sim = similarPassages(base, text);
      if (sim.length) {
        activity('📘 لقى حاجة شبهها في السكيل: ' + sim[0].file).done();
        return toolErr('Not saved: the skill already has something very similar (' + sim.map((s) => s.file + ' ' + Math.round(s.score * 100) + '%').join(', ') + '). Closest passage in ' + sim[0].file + ':\n---\n' + sim[0].text +
          '\n---\nIf it says the same thing: do not save, tell the user it is already saved (and where). If the new lesson corrects or adds numbers: call save_to_skill with mode "replace", find = that exact passage, text = the merged version. Only if it is genuinely a different lesson, call again with is_new_after_check: true.');
      }
    }
    let next;
    if (args.mode === 'replace') {
      const find = String(args.find || '');
      const at = find ? old.indexOf(find) : -1;
      if (at < 0) return toolErr('"find" was not found in ' + rel + '. Read the file and copy the exact passage.');
      if (old.indexOf(find, at + 1) >= 0) return toolErr('"find" appears more than once in ' + rel + '; give a longer passage.');
      next = old.slice(0, at) + text + old.slice(at + find.length);
    } else {
      const after = String(args.after_text || '');
      const at = after ? old.indexOf(after) : -1;
      if (after && at < 0) return toolErr('"after_text" was not found in ' + rel + '.');
      if (at >= 0) { const eol = old.indexOf('\n', at); const cut = eol < 0 ? old.length : eol + 1; next = old.slice(0, cut) + text.replace(/\n?$/, '\n') + old.slice(cut); }
      else next = (old ? old.replace(/\n*$/, '\n\n') : '') + text.replace(/\n?$/, '\n');
    }
    // every change keeps a backup of the old file and a line in .history/CHANGES.log, so any save can be undone
    const hist = path.join(base, '.history'); fs.mkdirSync(hist, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    if (old) fs.writeFileSync(path.join(hist, stamp + '-' + rel.replace(/[\\/]/g, '__')), old);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, next);
    fs.appendFileSync(path.join(hist, 'CHANGES.log'), stamp + ' | ' + rel + ' | ' + (args.mode === 'replace' ? 'replace' : 'append') + ' | ' + String(args.summary || '').replace(/\s+/g, ' ') + '\n');
    activity('📘 اتحفظ في السكيل: ' + rel + (args.summary ? ' — ' + args.summary : '')).done();
    return toolOk('Saved to ' + rel + ' (' + (args.mode === 'replace' ? 'replaced one passage' : 'appended') + '). The old version is in .history.');
  }

  // ------------------------------------------------------------------ local MCP server (Streamable HTTP, JSON responses)
  const TOKEN = crypto.randomBytes(16).toString('hex');
  let PORT = 0;
  const server = http.createServer(async (req, res) => {
    const hostOk = req.headers.host === '127.0.0.1:' + PORT || req.headers.host === 'localhost:' + PORT;
    if (!hostOk || req.headers.origin) { res.writeHead(403); return res.end(); }         // no browsers, no DNS rebinding
    if (req.url !== '/mcp/' + TOKEN) { res.writeHead(404); return res.end(); }
    if (req.method === 'GET') { res.writeHead(405, { Allow: 'POST' }); return res.end(); }
    if (req.method === 'DELETE') { res.writeHead(200); return res.end(); }
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (d) => { body += d; });
    await new Promise((r) => req.on('end', r));
    let msg;
    try { msg = JSON.parse(body); } catch (e) { return sendJSON(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    const batch = Array.isArray(msg) ? msg : [msg];
    const replies = [];
    for (const m of batch) { const r = await handleRPC(m); if (r) replies.push(r); }
    if (!replies.length) { res.writeHead(202); return res.end(); }
    sendJSON(res, 200, Array.isArray(msg) ? replies : replies[0]);
  });
  function sendJSON(res, code, obj) {
    const s = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': NodeBuffer.byteLength(s) });
    res.end(s);
  }
  async function handleRPC(m) {
    if (m.id === undefined || m.id === null) return null;                              // notification
    const reply = (result) => ({ jsonrpc: '2.0', id: m.id, result });
    switch (m.method) {
      case 'initialize':
        return reply({ protocolVersion: (m.params && m.params.protocolVersion) || '2025-06-18',
          capabilities: { tools: {} }, serverInfo: { name: 'abdulrahman-saad-motion', version: '1.0.0' } });
      case 'ping': return reply({});
      case 'tools/list': return reply({ tools: TOOLS });
      case 'tools/call':
        try { return reply(await callTool(m.params && m.params.name, m.params && m.params.arguments)); }
        catch (e) { return reply(toolErr(String(e && e.message || e))); }
      default:
        return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found: ' + m.method } };
    }
  }

  // ------------------------------------------------------------------ Claude Code binary (standalone install or the one inside the Claude app)
  function findClaude() {
    const name = IS_WIN ? 'claude.exe' : 'claude', home = os.homedir(), found = [];
    const add = (exe) => { try { const st = fs.statSync(exe); if (st.isFile()) found.push({ exe, t: st.mtimeMs }); } catch (e) {} };
    const scan = (base) => {                                                            // <base>/<version>/[<arch>/]claude
      try {
        for (const ver of fs.readdirSync(base)) {
          const vdir = path.join(base, ver); add(path.join(vdir, name));
          try { for (const h of fs.readdirSync(vdir)) add(path.join(vdir, h, name)); } catch (e) {}
        }
      } catch (e) {}
    };
    add(path.join(home, '.local', 'bin', name));
    if (IS_WIN) {
      const la = process.env.LOCALAPPDATA || '', ad = process.env.APPDATA || '';
      try { for (const pk of fs.readdirSync(path.join(la, 'Packages'))) if (/^Claude_/.test(pk)) scan(path.join(la, 'Packages', pk, 'LocalCache', 'Roaming', 'Claude', 'claude-code')); } catch (e) {}
      scan(path.join(ad, 'Claude', 'claude-code'));
    } else {
      add('/opt/homebrew/bin/claude'); add('/usr/local/bin/claude'); add(path.join(home, '.claude', 'local', 'claude'));
      scan(path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code'));
    }
    found.sort((a, b) => b.t - a.t);
    return found.length ? found[0].exe : null;
  }
  // "claude-opus-5-5" -> "Opus 5.5"
  function prettyModel(id) {
    const m = /claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id || '');
    if (!m) return id || 'Claude';
    return m[1].charAt(0).toUpperCase() + m[1].slice(1) + ' ' + m[2] + (m[3] && m[3].length <= 2 ? '.' + m[3] : '');
  }
  // Sign in: a terminal window running `claude auth login`; the user approves it in the browser with their Claude account.
  function openLogin() {
    const exe = findClaude(); if (!exe) { message('err', 'مش لاقي Claude Code على الجهاز. سطّبه الأول وبعدين جرّب تاني.'); return; }
    if (IS_WIN) cp.spawn('cmd.exe', ['/c', 'start', '"Claude login"', 'cmd.exe', '/k', '"' + exe + '"', 'auth', 'login'], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore' }).unref();
    else {
      const cmd = ("'" + exe.replace(/'/g, "'\\''") + "' auth login").replace(/(["\\])/g, '\\$1');
      cp.spawn('osascript', ['-e', 'tell application "Terminal" to do script "' + cmd + '"', '-e', 'tell application "Terminal" to activate'], { detached: true, stdio: 'ignore' }).unref();
    }
    message('claude', 'فتحتلك شباك تسجيل الدخول: كمّل في المتصفح بحساب Claude بتاعك، ولما يقول إنه اتسجّل اقفل الشباك وارجع هنا.');
  }
  function openFolder(dir) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    cp.spawn(IS_WIN ? 'explorer.exe' : 'open', [dir], { detached: true, stdio: 'ignore' }).unref();
  }

  // ------------------------------------------------------------------ what Claude knows about this panel
  function systemPrompt() {
    const s = linkedSkill();
    return [
      'You are Claude inside Adobe After Effects, through the «Abdulrahman Saad Motion» panel. The user is Abdulrahman Saad (عبدالرحمن سعد), video editor and motion designer, talking to you from inside After Effects.',
      'His brand identity is the default for every design you make here unless he asks otherwise: colors dark #1A150D, dark-2 #241D13, ink #2B2214, gold #B0864A, gold-1 #8B6B2E (gold on light), gold-3 #D4AF6A (gold on dark), gold-lt #E9C888 (highlight word on dark), cream #FDFBF6, cream-2 #F2E4C2, muted #7A6A4E / #A3937A, never pure #000 or #FFF; fonts Thmanyah Serif Display (700 titles, 500 for the gold second line), Thmanyah Sans (700 captions, 500 spaced caps labels), The Year of The Camel for the English name only; easing cubic-bezier(.16,1,.3,1), never linear; no glow, no neon, no gradients, no italics, no emoji, at most one gold word per caption or scene; no music in any audio (non-musical sound effects only); never change or replace the background of his footage. The full rules are in the linked skill.',
      'Reply in the user\'s language (Egyptian Arabic when they write Arabic), short and practical. Code, property names and matchNames stay in English.',
      'Act on After Effects only through these tools: mcp__asm__run_extendscript (ExtendScript ES3 as one undo group: no let/const/arrow functions/template literals; JSON is provided; helpers: asmComp(name) = the active comp when name is empty, asmEase(prop, keyIndex, [x1,y1,x2,y2]) gives the segment between key k and k+1 exactly that graph (AE influence/speed), asmEaseAll(prop, [x1,y1,x2,y2]), asmFindEffect(/name/i) -> [{name, matchName, category}], asmBrand = his colors as AE [r,g,b] (dark, dark2, ink, gold, gold1, gold3, goldLt, cream, cream2, muted, muted2) + ease [.16,1,.3,1] + nameAr/nameEn/role/handle/site, asmBrandFont(kind, weight) = the installed PostScript name of Thmanyah Sans / Thmanyah Serif Display / The Year of The Camel (use it for every textDocument.font)); mcp__asm__snapshot_frame (one frame as an image: for a still design); mcp__asm__preview_sheet (many frames on one contact sheet: this is how you SEE motion. Use it on every entrance, scene and transition, and before you say any motion is done: look for stops, empty or crowded frames, collisions and wrong timing, fix them, and check again); mcp__asm__read_animation (reads an animation the user made); mcp__asm__save_to_skill (saves what the user teaches).',
      s ? 'The skill linked to this panel is "' + s.name + '" (' + s.path + '). It is the user\'s own motion playbook, written by them with you. Before any motion, scene, transition or text-animation task, open it with the Skill tool and follow it exactly: its graphs, transitions, overlapping, text animations and rules. When something is not in it, use a simple sensible default and say so in one line. Never present as the user\'s rule something they did not teach.'
        : 'No skill is linked to this panel yet. When the user wants to teach you something or asks for motion work, tell them in one line to open the panel settings (gear icon) and create or pick a skill.',
      'LEARNING. The user teaches you by showing what they built in After Effects. This starts when they press «اتعلّم الأنيميشن» OR say it in their own words, e.g. "عملت تكست انيميشن خش شوفه", "شوف اللايرز بتاعتي وترتيبها والجرافات", "اتعلم ده", "احفظ اسلوبي". Never ask them to press the button or to select layers. 1) call mcp__asm__read_animation on the comp they name or the active one: their selection if they selected layers, else every layer (all_layers: true when they talk about the whole comp, their layers, the order or their way of working); open the precomps that hold the animation with comp_name; 2) explain in 3-8 short lines what you see: how the comp is built (layer order, the parenting chain such as one null per move, 3D, precomps, adjustment layers, blend modes and mattes), which properties move, from what to what, over how many frames, each graph (AE influence/speed and the cubic-bezier), how the moves overlap (the offset in frames between layers, words or nulls), the effects and their values; 3) save it with mcp__asm__save_to_skill under a clear name (the user\'s name for it if they gave one) with every number needed to rebuild it exactly, in the matching topic file (graphs, transitions, text animations, rules) plus one line in SKILL.md that points to it; 4) tell them in one line what you saved and where. When they later ask for that animation, rebuild it exactly from the skill (same values, frames and graphs), changing only what they ask (timing, size, text). The same goes for lessons they explain in words: save them the same way.',
      'REFERENCE IMAGES. When the user attaches images, open each one with the Read tool first. Study what matters: layout and positions as fractions of the frame, sizes, colors (hex), fonts and weights, spacing, hierarchy. Then do what they ask: recreate it, or use it as the reference for a new scene. If no comp fits, create one with the reference\'s aspect ratio. Build with shape and text layers, then compare with snapshot_frame and fix the differences.',
      'SPEECH AND CAPTIONS. You cannot hear audio by yourself: before captions, or any animation that must land on a spoken word, call mcp__asm__listen_timeline. It returns every word with its comp time and frame (also saved in <working folder>\\.claude\\listen\\<comp>.json, so use that file again instead of listening twice unless the audio changed). Read the words like a script, fix obvious misspellings from the context, and when the user gives a time or a spelling, theirs wins.',
      'Speed: After Effects is frozen while a script runs. A simple request gets one short script, at most one snapshot, then a 1-2 line reply. Keep scripts short; never loop over app.effects (use asmFindEffect).',
      'Safety: never delete, move or overwrite files on disk; never close, create or save the project unless asked; only touch the comps and layers the request is about. You may write new files only inside the working folder.'
    ].join('\n');
  }

  // what Claude Code's own tools are doing, in plain words
  function toolLabel(name, input) {
    const base = (p) => path.basename(String(p || ''));
    if (name === 'Skill') return '📘 فتح السكيل: ' + (input.skill || input.command || '');
    if (name === 'Read') return '📖 بيقرا: ' + base(input.file_path);
    if (name === 'Edit' || name === 'Write' || name === 'MultiEdit') return '💾 بيحفظ: ' + base(input.file_path);
    if (name === 'Glob' || name === 'Grep') return '🔎 بيدوّر: ' + String(input.pattern || '').slice(0, 40);
    if (name === 'TodoWrite') return '📝 خطة الشغل';
    return '🔧 ' + name;
  }

  // ------------------------------------------------------------------ one run of Claude Code
  let proc = null, lastModel = '';
  function runClaude(prompt) {
    const exe = findClaude();
    if (!exe) { message('err', 'مش لاقي Claude Code على الجهاز. سطّبه الأول (claude.com/code) وسجّل دخول بحساب Claude بتاعك.'); return; }
    if (!PORT) { message('err', 'البانل لسه بتجهّز، جرّب تاني بعد ثانية.'); return; }
    const bad = cwdProblem(settings.cwd); if (bad) { message('err', bad); return; }
    if (!ensureCwd()) { message('err', 'مش قادر أعمل فولدر الشغل: ' + settings.cwd); return; }
    // writing: the working folder and this folder's own memory only; never ~/.claude/skills or a protected memory
    const mem = '~/.claude/projects/' + projectKey(settings.cwd) + '/memory/**';
    const deny = ['~/.claude/skills/**'].concat(PROTECTED_KEYS.map((k) => '~/.claude/projects/' + k + '/**'));
    const mcpFile = path.join(os.tmpdir(), 'as-motion-mcp-' + process.pid + '.json');
    fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { asm: { type: 'http', url: 'http://127.0.0.1:' + PORT + '/mcp/' + TOKEN } } }));
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--mcp-config', mcpFile, '--strict-mcp-config',
      // AE tools + the skill + reading; writing only inside the working folder and Claude's memory, no shell
      // (Edit(path) rules cover every file-writing tool, Write included; a deny always beats an allow)
      '--allowedTools', 'mcp__asm__run_extendscript,mcp__asm__snapshot_frame,mcp__asm__preview_sheet,mcp__asm__read_animation,mcp__asm__save_to_skill,mcp__asm__listen_timeline,Skill,TodoWrite,Read,Glob,Grep,Edit(./**),Edit(' + mem + ')',
      '--disallowedTools', deny.map((p) => 'Edit(' + p + ')').join(','),
      '--permission-mode', 'dontAsk',
      '--append-system-prompt', systemPrompt()];
    const off = otherSkillsOff();
    if (Object.keys(off).length) args.push('--settings', JSON.stringify({ skillOverrides: off }));
    if (settings.model) args.push('--model', settings.model);
    if (settings.effort) args.push('--effort', settings.effort);
    if (sessionId) args.push('--resume', sessionId);

    busy(true);
    showTyping();
    let out = '', errTail = '', gotResult = false, live = null, liveText = '', liveRaf = 0;
    // ENABLE_TOOL_SEARCH=false: the AE tools are loaded up front, so no search round trip before the first action
    // tools may take long (the first listen downloads Whisper): up to 30 min each
    proc = cp.spawn(exe, args, { cwd: settings.cwd, env: Object.assign({}, process.env, { MCP_TOOL_TIMEOUT: '1800000', ENABLE_TOOL_SEARCH: 'false' }), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

    const endLive = () => { if (live) { live.innerHTML = renderMarkdown(liveText); live.classList.remove('cursor'); live = null; liveText = ''; if (proc && !gotResult) showTyping(); } };
    const onEvent = (ev) => {
      if (ev.session_id && ev.session_id !== sessionId) setSession(ev.session_id);
      if (ev.type === 'system' && ev.subtype === 'init' && ev.model) { lastModel = ev.model; status('Claude شغال… (' + prettyModel(ev.model) + ')', 'busy'); }
      if (ev.parent_tool_use_id) return;                                               // subagent traffic
      if (ev.type === 'stream_event' && ev.event) {
        const e = ev.event;
        if (e.type === 'message_start') endLive();
        if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta') {
          if (!live) { hideTyping(); live = message('claude', ''); live.classList.add('cursor'); }
          liveText += e.delta.text;
          if (!liveRaf) liveRaf = requestAnimationFrame(() => { liveRaf = 0; if (live) { live.innerHTML = renderMarkdown(liveText); scrollDown(); } });
        }
        if (e.type === 'message_stop') endLive();
      } else if (ev.type === 'assistant' && ev.message) {
        for (const b of ev.message.content || []) if (b.type === 'tool_use' && !/^mcp__asm__/.test(b.name)) activity(toolLabel(b.name, b.input || {})).done();
      } else if (ev.type === 'rate_limit_event' && ev.rate_limit_info && ev.rate_limit_info.status === 'rejected') {
        const r = ev.rate_limit_info, when = r.resetsAt ? new Date(r.resetsAt * 1000).toLocaleString('ar-EG', { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
        message('err', 'خلصت الليمت بتاع اشتراكك' + (when ? ' · بيرجع ' + when : ''));
      } else if (ev.type === 'result') {
        gotResult = true; endLive(); hideTyping();
        if (ev.is_error || ev.subtype !== 'success') {
          const t = String(ev.result || ev.subtype || 'error');
          if (/no conversation found/i.test(t) && sessionId) setSession(null);
          message('err', /not logged in|please run \/login|authenticat/i.test(t) ? 'Claude Code مش مسجّل دخول: دوس ⚙ وبعدين «تسجيل الدخول».' : t);
        }
      }
    };
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => {
      out += d; let i;
      while ((i = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, i).trim(); out = out.slice(i + 1);
        if (line) { try { onEvent(JSON.parse(line)); } catch (e) {} }
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => { errTail = (errTail + d).slice(-2000); });
    proc.on('error', (e) => { message('err', 'مقدرتش أشغّل Claude Code: ' + e.message); busy(false); proc = null; });
    proc.on('close', (code) => {
      endLive();
      if (!gotResult && code !== 0 && code !== null) message('err', 'Claude Code قفل بكود ' + code + (errTail ? '\n' + errTail : ''));
      busy(false); proc = null;
    });
  }

  // ------------------------------------------------------------------ UI
  const msgs = $('messages');
  function scrollDown() { msgs.scrollTop = msgs.scrollHeight; }
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function renderMarkdown(src) {
    return String(src).split(/```/).map((p, i) => {
      if (i % 2 === 1) return '<pre><code>' + esc(p.replace(/^[a-zA-Z]*\n/, '')) + '</code></pre>';
      return esc(p).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    }).join('');
  }
  const ICON_SPARK = '<svg viewBox="18 8 102 104"><polygon points="30,20 55.97,34.84 63.35,80.94 30,100" fill="#B0864A"/><polygon points="62.97,34.84 107,60 70.35,80.94" fill="#D4AF6A"/></svg>';
  const ICON_SEND = '<svg viewBox="0 0 24 24"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>';
  const ICON_STOP = '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/></svg>';

  let typingEl = null;
  function clearWelcome() { const w = msgs.querySelector('.welcome'); if (w) w.remove(); }
  function keepTypingLast() { if (typingEl && typingEl.parentNode) msgs.appendChild(typingEl); }
  function showTyping() {
    if (!typingEl) { typingEl = document.createElement('div'); typingEl.className = 'typing'; typingEl.innerHTML = '<i></i><i></i><i></i>'; }
    msgs.appendChild(typingEl); scrollDown();
  }
  function hideTyping() { if (typingEl && typingEl.parentNode) typingEl.remove(); }
  // Returns the element that holds the text (so streaming can keep updating it).
  function message(kind, text) {
    clearWelcome();
    let inner;
    if (kind === 'err') {
      inner = document.createElement('div'); inner.className = 'msg err'; inner.textContent = text; msgs.appendChild(inner);
    } else {
      const row = document.createElement('div'); row.className = 'row ' + kind;
      if (kind === 'claude') { const a = document.createElement('div'); a.className = 'avatar'; a.innerHTML = ICON_SPARK; row.appendChild(a); }
      inner = document.createElement('div'); inner.className = 'msg ' + kind;
      inner.innerHTML = kind === 'claude' ? renderMarkdown(text) : esc(text);
      row.appendChild(inner); msgs.appendChild(row);
    }
    keepTypingLast(); scrollDown(); return inner;
  }
  // A step inside After Effects, shown as a chip: running -> done / error.
  function activity(text) {
    clearWelcome();
    const d = document.createElement('div'); d.className = 'chip running';
    d.innerHTML = '<span class="ico"></span><span class="txt"></span>';
    const t = d.querySelector('.txt'); t.textContent = text; d.title = text;
    msgs.appendChild(d); keepTypingLast(); scrollDown();
    return {
      done(label) { d.className = 'chip done'; if (label) { t.textContent = label; d.title = label; } },
      update(label) { t.textContent = label; d.title = label; },
      fail(err) { d.className = 'chip error'; t.textContent = text + ' — ' + err; d.title = String(err); }
    };
  }
  // what Claude is looking at (click to enlarge)
  function showImage(dataUrl, caption) {
    clearWelcome();
    const d = document.createElement('div'); d.className = 'shot';
    const img = document.createElement('img'); img.src = dataUrl; img.onclick = () => d.classList.toggle('big');
    d.appendChild(img);
    if (caption) { const cap = document.createElement('div'); cap.className = 'cap'; cap.textContent = caption; d.appendChild(cap); }
    msgs.appendChild(d); keepTypingLast(); scrollDown();
  }
  function status(text, state) { $('status').textContent = text; $('dot').className = 'dot ' + (state || ''); }
  function busy(on) {
    const b = $('send');
    b.innerHTML = on ? ICON_STOP : ICON_SEND; b.classList.toggle('stop', on); b.title = on ? 'إيقاف' : 'ابعت';
    status(on ? 'Claude شغال…' : 'جاهز' + (lastModel ? ' · ' + prettyModel(lastModel) : ''), on ? 'busy' : 'ok');
    if (!on) hideTyping();
  }
  function syncToggles() {
    $('shotWrap').classList.toggle('on', $('shot').checked);
    $('effortWrap').classList.toggle('on', settings.effort === 'xhigh' || settings.effort === 'max');
  }
  function autoGrow() { const t = $('input'); t.style.height = 'auto'; t.style.height = Math.min(180, t.scrollHeight) + 'px'; }

  // ------------------------------------------------------------------ reference images (button, Ctrl+V, drag & drop)
  // Saved in <working folder>/References so Claude Code's Read tool can open them.
  const IMG_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };
  const EXT_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
  let attachments = [];                                                                 // { file, url }
  function refsDir() { const d = path.join(settings.cwd, 'References'); fs.mkdirSync(d, { recursive: true }); return d; }
  function addImageBlob(blob, name) {
    if (!blob) return;
    const type = blob.type || EXT_TYPES[String(name || '').split('.').pop().toLowerCase()] || '';
    const ext = IMG_TYPES[type];
    if (!ext) { message('err', 'ابعت صورة (PNG / JPG / WEBP / GIF).'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const safe = String(name || 'reference').replace(/\.[^.]+$/, '').replace(/[^\w\-]+/g, '_').slice(0, 40) || 'reference';
      let file;
      try { file = path.join(refsDir(), Date.now() + '-' + safe + ext); fs.writeFileSync(file, NodeBuffer.from(new Uint8Array(reader.result))); }
      catch (e) { message('err', 'مقدرتش أحفظ الصورة: ' + e.message); return; }
      attachments.push({ file, url: URL.createObjectURL(blob) });
      renderAttachments();
    };
    reader.readAsArrayBuffer(blob);
  }
  function renderAttachments() {
    const box = $('attachments'); box.innerHTML = '';
    attachments.forEach((a, i) => {
      const d = document.createElement('div'); d.className = 'att';
      d.innerHTML = '<img alt=""><button title="شيل الصورة">×</button>';
      d.querySelector('img').src = a.url;
      d.querySelector('button').onclick = () => { attachments.splice(i, 1); renderAttachments(); };
      box.appendChild(d);
    });
    box.classList.toggle('has', attachments.length > 0);
  }
  $('attachBtn').onclick = () => $('filePick').click();
  $('filePick').onchange = (e) => { for (const f of Array.from(e.target.files || [])) addImageBlob(f, f.name); e.target.value = ''; };
  document.addEventListener('paste', (e) => {
    const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
    for (const it of items) if (it.kind === 'file' && /^image\//.test(it.type)) { e.preventDefault(); addImageBlob(it.getAsFile(), 'pasted'); }
  });
  let dragDepth = 0;
  document.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('drop').classList.add('show'); });
  document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop').classList.remove('show'); } });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault(); dragDepth = 0; $('drop').classList.remove('show');
    for (const f of Array.from((e.dataTransfer && e.dataTransfer.files) || [])) {
      if (/\.(zip|skill)$/i.test(f.name)) readBlob(f).then((b) => importSkill(b, f.name.replace(/\.[^.]+$/, '')));   // a skill package
      else addImageBlob(f, f.name);
    }
  });
  function readBlob(blob) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(NodeBuffer.from(new Uint8Array(r.result))); r.onerror = () => rej(r.error); r.readAsArrayBuffer(blob); });
  }

  // ------------------------------------------------------------------ sending
  // learn = the «اتعلّم الأنيميشن» button: Claude reads the selected layers and saves the animation to the skill
  function send(learn) {
    if (proc) { try { proc.kill(); } catch (e) {} return; }                            // the button doubles as Stop
    let text = $('input').value.trim();
    const withShot = $('shot').checked, imgs = attachments.slice();
    if (!learn && !text && !withShot && !imgs.length) return;
    const shown = learn ? '🎓 اتعلّم الأنيميشن ده' + (text ? '\n' + text : '') : (text || (imgs.length ? 'خد الريفرنس ده واعمل منه مشهد' : 'بص على الكومب'));
    const bubble = message('user', (withShot ? '📸 ' : '') + shown);
    if (imgs.length) {
      const t = document.createElement('div'); t.className = 'thumbs';
      for (const a of imgs) { const im = document.createElement('img'); im.src = a.url; t.appendChild(im); }
      bubble.insertBefore(t, bubble.firstChild);
    }
    if (learn) text = '[The user pressed «اتعلّم الأنيميشن» with the animated layers selected in After Effects: learn this animation (read_animation, explain briefly, save it to the skill).' + (text ? ' What they wrote is its name or notes.' : '') + ']\n' + (text || 'اتعلّم الأنيميشن ده');
    else if (!text && imgs.length) text = 'خد الريفرنس ده واعمل منه مشهد في After Effects.';
    if (withShot) text = '[The user attached the current frame: call mcp__asm__snapshot_frame first to see it.]\n' + (text || 'بص على الكومب وقولّي شايف إيه.');
    if (imgs.length) text = '[The user attached ' + imgs.length + ' reference image(s). Open each one with the Read tool before answering:\n' + imgs.map((a) => '- ' + a.file).join('\n') + ']\n' + text;
    attachments = []; renderAttachments();
    $('input').value = ''; $('shot').checked = false; syncToggles(); autoGrow();
    runClaude(text);
  }
  $('shot').addEventListener('change', syncToggles);
  // the thinking level is remembered and applies from the next message (a running chat too)
  $('effort').value = settings.effort;
  $('effort').addEventListener('change', () => { settings.effort = $('effort').value; saveSettings(); syncToggles(); });
  syncToggles();
  $('input').addEventListener('input', autoGrow);
  $('send').onclick = () => send(false);
  $('learnBtn').onclick = () => { if (!proc) send(true); };
  $('input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(false); } });
  $('newChat').onclick = () => { if (proc) { try { proc.kill(); } catch (e) {} } setSession(null); msgs.innerHTML = ''; greet(); };

  // ------------------------------------------------------------------ skills: link, add (zip / folder), create, export
  // Linking another skill starts a new chat: the chat's instructions name the linked skill.
  function linkSkill(p) {
    const changed = p !== settings.skillPath;
    settings.skillPath = p; saveSettings(); renderSkillPill();
    if (changed) { if (proc) { try { proc.kill(); } catch (e) {} } setSession(null); msgs.innerHTML = ''; greet(); }
  }
  const PACK_ERR = { NO_SKILL_MD: 'ده مش سكيل: مفيهوش ملف SKILL.md', NOT_ZIP: 'الملف ده مش ZIP سليم', ENCRYPTED: 'الـ ZIP ده عليه باسورد' };
  // source: a .zip / .skill path or Buffer, a folder path, or a list of {name, data} files (folder picker fallback).
  // The skill is always COPIED into <working folder>/.claude/skills: the source is only read, never changed.
  function importSkill(source, fallbackName) {
    try {
      const bad = cwdProblem(settings.cwd); if (bad) throw new Error(bad);
      if (!ensureCwd()) throw new Error('مش قادر أعمل فولدر الشغل: ' + settings.cwd);
      const r = pack.installSkill(source, projectSkillsDir(), path.join(settings.cwd, '.claude', 'skill-backups'), fallbackName);
      linkSkill(r.path);
      if ($('settings').classList.contains('open')) fillSkillSelect();
      message('claude', '📥 ضفت نسخة من السكيل **' + r.name + '** (' + r.files + ' ملف) في فولدر الشغل وربطتها بالبانل. الأصل ما اتلمسش، وكل اللي هتعلّمهولي هيتحفظ في النسخة دي بس.' +
        (r.replaced ? '\nكان فيه نسخة قبل كده بنفس الاسم، واتنقلت هنا: ' + r.replaced : ''));
    } catch (e) { message('err', 'مقدرتش أضيف السكيل: ' + (PACK_ERR[e.message] || e.message)); }
  }
  // a skill of this computer (~/.claude/skills): the panel works on its own copy, the original is never written
  function useComputerSkill(dir) {
    const s = skillAt(dir); if (!s) return;
    const copy = path.join(projectSkillsDir(), pack.safeName(s.name) || 'skill');
    if (skillAt(copy)) { linkSkill(copy); fillSkillSelect(); message('claude', '📘 السكيل **' + s.dir + '** متنسخة هنا قبل كده، فربطت النسخة. الأصل ما اتلمسش.'); return; }
    importSkill(dir, s.dir);
  }
  // After Effects' own file / folder dialog (CEP); undefined when it is not available
  function pickPath(folder) {
    const c = window.cep && window.cep.fs;
    if (!c || !c.showOpenDialogEx) return undefined;
    const r = c.showOpenDialogEx(false, folder, folder ? 'اختار فولدر السكيل' : 'اختار ملف السكيل (.zip)', '', folder ? [] : ['zip', 'skill']);
    const p = r && !r.err && r.data && r.data[0];
    if (!p) return null;
    return /^file:/.test(p) ? decodeURI(p).replace(IS_WIN ? /^file:\/{3}/ : /^file:\/\//, '') : String(p);
  }
  function revealFile(f) {
    if (IS_WIN) cp.spawn('explorer.exe', ['/select,"' + f + '"'], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore' }).unref();
    else cp.spawn('open', ['-R', f], { detached: true, stdio: 'ignore' }).unref();
  }
  function exportLinkedSkill() {
    const s = linkedSkill(); if (!s) { message('err', 'اربط سكيل الأول.'); return; }
    try {
      ensureCwd();
      let out = path.join(settings.cwd, s.dir + '.zip'), n = 2;
      while (fs.existsSync(out)) out = path.join(settings.cwd, s.dir + '-' + (n++) + '.zip');
      const r = pack.exportSkill(s.path, out);
      message('claude', '📤 صدّرت السكيل **' + s.dir + '** في ملف واحد (' + r.files + ' ملف جواه):\n' + out +
        '\nده الملف اللي تديه للناس: يسحبوه ويرموه على البانل، أو يضيفوه من ⚙ ← «ضيف سكيل». وكمان بيترفع على claude.ai زي ما هو.');
      revealFile(out);
    } catch (e) { message('err', 'مقدرتش أصدّر السكيل: ' + (PACK_ERR[e.message] || e.message)); }
  }

  // ------------------------------------------------------------------ settings sheet
  function fillSkillSelect() {
    const sel = $('skillSel'), off = folderOffSkills(), shown = (s) => off[s.dir] !== 'off' && off[s.name] !== 'off';
    const groups = [['في فولدر الشغل', skillsIn(projectSkillsDir()).filter(shown)], ['على الجهاز (البانل بتاخد نسخة، والأصل ما بيتلمسش)', skillsIn(userSkillsDir()).filter(shown)]];
    const opt = (parent, value, text) => { const o = document.createElement('option'); o.value = value; o.textContent = text; parent.appendChild(o); };
    sel.innerHTML = '';
    opt(sel, '', groups.some((g) => g[1].length) ? 'اختار سكيل…' : 'مفيش سكيلز لسه: ضيف واحدة أو اعمل جديدة');
    for (const [label, list] of groups) {
      if (!list.length) continue;
      const g = document.createElement('optgroup'); g.label = label;
      for (const s of list) opt(g, s.path, s.dir);
      sel.appendChild(g);
    }
    opt(sel, '__import', '📥 ضيف سكيل (ملف ZIP أو فولدر)…');
    opt(sel, '__new', '➕ سكيل جديدة فاضية…');
    sel.value = settings.skillPath && Array.from(sel.options).some((o) => o.value === settings.skillPath) ? settings.skillPath : '';
    showSkillRow('');
  }
  function showSkillRow(which) {
    $('newSkillRow').classList.toggle('show', which === 'new');
    $('importRow').classList.toggle('show', which === 'import');
    $('exportSkill').style.display = linkedSkill() && !which ? '' : 'none';
  }
  function openSettings(open, row) {
    $('settings').classList.toggle('open', open);
    $('settingsBtn').classList.toggle('active', open);
    if (!open) return;
    $('cwd').value = settings.cwd; $('model').value = settings.model;
    fillSkillSelect();
    if (row) { $('skillSel').value = row === 'import' ? '__import' : '__new'; showSkillRow(row); }
    const exe = findClaude(); $('exeHint').textContent = exe ? 'Claude Code: ' + exe : 'Claude Code: not found';
  }
  $('settingsBtn').onclick = () => openSettings(!$('settings').classList.contains('open'));
  $('skillPill').onclick = () => openSettings(true, linkedSkill() ? '' : 'import');
  $('skillSel').onchange = () => {
    const v = $('skillSel').value;
    if (v === '__new') { showSkillRow('new'); $('newSkill').focus(); return; }
    if (v === '__import') { showSkillRow('import'); return; }
    if (v && isInside(v, userSkillsDir())) { useComputerSkill(v); return; }
    linkSkill(v); showSkillRow('');
  };
  $('importZip').onclick = () => { const p = pickPath(false); if (p === undefined) $('zipPick').click(); else if (p) importSkill(p); };
  $('importDir').onclick = () => { const p = pickPath(true); if (p === undefined) $('dirPick').click(); else if (p) importSkill(p); };
  $('zipPick').onchange = (e) => {
    const f = e.target.files && e.target.files[0]; e.target.value = '';
    if (f) readBlob(f).then((b) => importSkill(b, f.name.replace(/\.[^.]+$/, '')));
  };
  $('dirPick').onchange = (e) => {
    const files = Array.from(e.target.files || []); e.target.value = '';
    if (!files.length) return;
    Promise.all(files.map((f) => readBlob(f).then((data) => ({ name: f.webkitRelativePath || f.name, data }))))
      .then((list) => importSkill(list, (files[0].webkitRelativePath || '').split('/')[0]));
  };
  $('exportSkill').onclick = exportLinkedSkill;
  // the folder typed in the box counts right away (skills list and folder button follow it); unsafe folders are refused
  $('cwd').addEventListener('change', () => {
    const v = $('cwd').value.trim(); if (!v || v === settings.cwd) return;
    const bad = cwdProblem(v); if (bad) { message('err', bad); $('cwd').value = settings.cwd; return; }
    settings.cwd = v; setSession(null); saveSettings(); fillSkillSelect(); renderSkillPill();
  });
  $('openFolder').onclick = () => openFolder($('cwd').value.trim() || settings.cwd);
  $('createSkill').onclick = () => {
    try {
      const bad = cwdProblem(settings.cwd); if (bad) throw new Error(bad);
      ensureCwd();
      const dir = createSkill($('newSkill').value);
      $('newSkill').value = ''; linkSkill(dir); fillSkillSelect();
      message('claude', 'عملت سكيل جديدة فاضية اسمها **' + path.basename(dir) + '** وربطتها بالبانل. أي حاجة تعلّمهالي من دلوقتي هتتحفظ فيها.');
    } catch (e) { message('err', e.message); }
  };
  $('saveSettings').onclick = () => {
    const cwd = $('cwd').value.trim() || DEFAULT_CWD;
    const bad = cwdProblem(cwd); if (bad) { message('err', bad); $('cwd').value = settings.cwd; return; }
    if (cwd !== settings.cwd) setSession(null);                                        // another folder = another memory: a new chat
    settings.cwd = cwd; settings.model = $('model').value;
    saveSettings(); ensureCwd(); renderSkillPill(); openSettings(false);
  };
  // One button: already signed in -> which account; not signed in (or no answer) -> the sign-in window
  $('loginBtn').onclick = () => {
    const exe = findClaude(); if (!exe) { message('err', 'مش لاقي Claude Code على الجهاز. سطّبه الأول (ملف التسطيب بيسطّبه لو مش موجود).'); return; }
    cp.execFile(exe, ['auth', 'status'], { windowsHide: true, timeout: 30000 }, (err, stdout) => {
      let s = null; try { s = JSON.parse(stdout); } catch (e) {}
      if (s && s.loggedIn) {
        const plan = { max: 'Max', pro: 'Pro', team: 'Team', enterprise: 'Enterprise', free: 'Free' }[s.subscriptionType] || s.subscriptionType || '';
        message('claude', 'انت متسجّل دخول ✅ بحساب ' + s.email + (plan ? ' · اشتراك ' + plan : ''));
      } else openLogin();
    });
  };

  // ------------------------------------------------------------------ welcome
  const SUGGESTIONS = [
    { t: 'اسمع الكومب واعمل كابشن كلمة كلمة بهويتي' },
    { t: 'اعمل اللوور ثيرد بتاعي: عبدالرحمن سعد — Video Editor' },
    { t: 'اعمل الإند كارد بتاعي باللوجو والاسم والهاندل' },
    { t: 'ابعت صورة ريفرنس وأنا أعمل منها مشهد بألوانك', pick: true },
    { t: 'اختار لاير عليه أنيميشن ودوس «اتعلّم الأنيميشن»', learn: true },
    { t: 'بص على الكومب وقولّي شايف إيه', shot: true }
  ];
  function greet() {
    const sk = linkedSkill();
    const w = document.createElement('div'); w.className = 'welcome';
    w.innerHTML = '<div class="kicker"><i></i><span class="caps">Video Editor — Motion Designer</span></div>' +
      '<div class="big">أهلًا يا عبدالرحمن،<em>خلّينا نشتغل بهويتك.</em></div>' +
      '<div class="sub">' + (sk ? 'السكيل المربوطة: <b class="latin">' + esc(sk.dir) + '</b>. ' : '') + 'أنا Claude جوه After Effects معاك. علّمني الأنيميشن بتاعك مرة، وأنا أعمله بعد كده لوحدي بألوانك وخطوطك. ابدأ بحاجة من دول:</div><div class="suggest"></div>';
    const box = w.querySelector('.suggest');
    for (const s of (sk ? [] : [{ t: 'ضيف سكيل (ملف ZIP أو فولدر) أو اعمل واحدة جديدة', skill: true }]).concat(SUGGESTIONS)) {
      const b = document.createElement('button'); b.textContent = s.t;
      b.onclick = () => {
        if (s.skill) { openSettings(true, 'import'); return; }
        if (s.pick) { $('filePick').click(); return; }
        if (s.learn) { $('input').focus(); status('اختار اللايرز في التايملاين، وبعدين دوس «اتعلّم الأنيميشن»', 'ok'); return; }
        $('input').value = s.t; if (s.shot) $('shot').checked = true; syncToggles(); autoGrow(); $('input').focus();
      };
      box.appendChild(b);
    }
    msgs.appendChild(w);
  }

  // Reopening the panel keeps the conversation: Claude resumes the same session, and the messages come back on screen
  // from that session's transcript.
  function restoreHistory() {
    if (!sessionId) return false;
    let file = null;
    try { const root = path.join(os.homedir(), '.claude', 'projects'); for (const d of fs.readdirSync(root)) { const f = path.join(root, d, sessionId + '.jsonl'); if (fs.existsSync(f)) { file = f; break; } } } catch (e) {}
    if (!file) return false;
    const items = [];
    try {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line || (line.indexOf('"type":"user"') < 0 && line.indexOf('"type":"assistant"') < 0)) continue;
        let j; try { j = JSON.parse(line); } catch (e) { continue; }
        if (j.isSidechain || j.isMeta || !j.message) continue;
        const m = j.message, txt = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '';
        if (j.type === 'user') {
          let t = String(txt || ''); if (!t.trim() || /^\s*</.test(t) || j.toolUseResult) continue;
          let att = '';
          while (/^\[[\s\S]*?\]\n/.test(t)) { const blk = /^\[[\s\S]*?\]\n/.exec(t)[0]; if (/اتعلّم الأنيميشن/.test(blk)) att += '🎓 '; else if (/image/i.test(blk)) att += '🖼️ '; else if (/current frame/.test(blk)) att += '📸 '; t = t.slice(blk.length); }
          items.push(['user', att + t.trim()]);
        } else if (txt.trim()) {
          const prev = items[items.length - 1];
          if (prev && prev[0] === 'claude' && prev[2] === m.id) prev[1] += '\n\n' + txt.trim(); else items.push(['claude', txt.trim(), m.id]);
        }
      }
    } catch (e) { return false; }
    if (!items.length) return false;
    for (const it of items.slice(-80)) message(it[0], it[1]);
    activity('↩️ كمّلنا نفس المحادثة').done();
    return true;
  }

  // ------------------------------------------------------------------ boot
  server.listen(0, '127.0.0.1', () => { PORT = server.address().port; });
  ensureCwd();
  // first start (e.g. right after the installer): when nothing is linked and the working folder holds exactly one
  // skill, link it by itself
  if (!linkedSkill()) { const only = skillsIn(projectSkillsDir()); if (only.length === 1) { settings.skillPath = only[0].path; saveSettings(); } }
  renderSkillPill();
  loadHost().then((r) => {
    if (String(r).indexOf('abdulrahman saad motion host loaded') < 0) { status('مشكلة في تحميل host.jsx: ' + r, 'bad'); return; }
    const exe = findClaude();
    status(exe ? 'جاهز' : 'مش لاقي Claude Code على الجهاز', exe ? 'ok' : 'bad');
  });
  if (!restoreHistory()) { setSession(null); greet(); }   // its transcript is gone (moved / new start): a clean chat, not a failed --resume
  if (cwdProblem(settings.cwd)) message('err', cwdProblem(settings.cwd) + ' (من ⚙)');
})();
