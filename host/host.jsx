// ExtendScript side of the Abdulrahman Saad Motion panel. Loaded into After Effects by the panel manifest (ScriptPath).
// Everything here is ES3. Kept ASCII-only so it loads the same under any file encoding.

// ------------------------------------------------------------------ JSON (ExtendScript has none)
(function () {
    if (typeof $.global.JSON != "undefined" && $.global.JSON.__asm) return;
    var SAFE = /^[\x20\x21\x23-\x5b\x5d-\x7e]*$/;
    function jq(s) {
        if (SAFE.test(s)) return '"' + s + '"';
        var out = ['"'];
        for (var i = 0; i < s.length; i++) {
            var c = s.charCodeAt(i), ch = s.charAt(i);
            if (ch == '"') out.push('\\"');
            else if (ch == "\\") out.push("\\\\");
            else if (c == 10) out.push("\\n");
            else if (c == 13) out.push("\\r");
            else if (c == 9) out.push("\\t");
            else if (c < 32 || c > 126) { var h = c.toString(16); while (h.length < 4) h = "0" + h; out.push("\\u" + h); }
            else out.push(ch);
        }
        out.push('"');
        return out.join("");
    }
    function isPlain(v) { return v instanceof Array || (v && v.constructor === Object); }
    function jstr(v) {
        if (v === null || v === undefined) return "null";
        var t = typeof v;
        if (t == "number") return isFinite(v) ? String(v) : "null";
        if (t == "boolean") return v ? "true" : "false";
        if (t == "string") return jq(v);
        if (!isPlain(v)) return jq(String(v));               // AE objects (Layer, CompItem...) become their string form
        if (v instanceof Array) { var a = []; for (var i = 0; i < v.length; i++) a.push(jstr(v[i])); return "[" + a.join(",") + "]"; }
        var o = [];
        for (var k in v) if (v.hasOwnProperty(k) && v[k] !== undefined && typeof v[k] != "function") o.push(jq(k) + ":" + jstr(v[k]));
        return "{" + o.join(",") + "}";
    }
    function jparse(s) {
        var i = 0;
        function ws() { while (i < s.length) { var c = s.charAt(i); if (c == " " || c == "\n" || c == "\r" || c == "\t") i++; else break; } }
        function str() {
            i++; var parts = [], start = i;
            while (true) {
                var q = s.indexOf('"', i), b = s.indexOf("\\", i);
                if (q < 0) throw new Error("Bad JSON string");
                if (b >= 0 && b < q) {
                    parts.push(s.substring(start, b));
                    var e = s.charAt(b + 1);
                    if (e == "u") { parts.push(String.fromCharCode(parseInt(s.substr(b + 2, 4), 16))); i = b + 6; }
                    else { parts.push(e == "n" ? "\n" : e == "r" ? "\r" : e == "t" ? "\t" : e == "b" ? "\b" : e == "f" ? "\f" : e); i = b + 2; }
                    start = i;
                } else { parts.push(s.substring(start, q)); i = q + 1; return parts.join(""); }
            }
        }
        function val() {
            ws(); var c = s.charAt(i);
            if (c == "{") { i++; var o = {}; ws(); if (s.charAt(i) == "}") { i++; return o; } while (true) { ws(); var k = str(); ws(); i++; o[k] = val(); ws(); var d = s.charAt(i++); if (d == "}") return o; } }
            if (c == "[") { i++; var a = []; ws(); if (s.charAt(i) == "]") { i++; return a; } while (true) { a.push(val()); ws(); var d2 = s.charAt(i++); if (d2 == "]") return a; } }
            if (c == '"') return str();
            if (c == "t") { i += 4; return true; }
            if (c == "f") { i += 5; return false; }
            if (c == "n") { i += 4; return null; }
            var m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(s.substr(i, 40));
            if (!m) throw new Error("Bad JSON at " + i);
            i += m[0].length; return Number(m[0]);
        }
        return val();
    }
    $.global.JSON = { stringify: jstr, parse: jparse, __asm: true };
})();

// ------------------------------------------------------------------ building helpers
// Find a comp by name, or the active comp when name is empty.
$.global.asmComp = function (name) {
    if (!name) {
        var a = app.project.activeItem;
        if (a instanceof CompItem) return a;
        throw new Error("No active composition. Open a comp in the viewer or pass its name.");
    }
    for (var i = 1; i <= app.project.numItems; i++) {
        var it = app.project.item(i);
        if (it instanceof CompItem && it.name == name) return it;
    }
    throw new Error("No composition named " + name);
};

// Give the segment between key k and k+1 a graph: cubic-bezier [x1, y1, x2, y2] on normalised (time, value),
// the same model AE uses between two keyframes. Influence = x1 and 1-x2; speed = curve slope x average speed
// (signed per dimension, path length for spatial properties).
$.global.asmEase = function (prop, k, c) {
    if (!(c instanceof Array) || c.length != 4) throw new Error("The graph must be [x1, y1, x2, y2].");
    if (k < 1 || k >= prop.numKeys) throw new Error("Key index out of range: " + k);
    var dt = prop.keyTime(k + 1) - prop.keyTime(k);
    var v1 = prop.keyValue(k), v2 = prop.keyValue(k + 1);
    if (!(v1 instanceof Array)) { v1 = [v1]; v2 = [v2]; }
    function clampInf(x) { return Math.max(0.1, Math.min(100, x)); }
    var outInf = clampInf(c[0] * 100), inInf = clampInf((1 - c[2]) * 100);
    var outR = c[0] > 0 ? c[1] / c[0] : 0, inR = (1 - c[2]) > 0 ? (1 - c[3]) / (1 - c[2]) : 0;
    prop.setInterpolationTypeAtKey(k, prop.keyInInterpolationType(k), KeyframeInterpolationType.BEZIER);
    prop.setInterpolationTypeAtKey(k + 1, KeyframeInterpolationType.BEZIER, prop.keyOutInterpolationType(k + 1));
    var n = prop.keyOutTemporalEase(k).length, outArr = [], inArr = [];
    var dist = 0; for (var d = 0; d < v1.length; d++) dist += (v2[d] - v1[d]) * (v2[d] - v1[d]); dist = Math.sqrt(dist);
    for (var i = 0; i < n; i++) {
        var avg = (n == 1) ? ((prop.isSpatial || v1.length > 1) ? dist : (v2[0] - v1[0])) / dt : (v2[i] - v1[i]) / dt;
        outArr.push(new KeyframeEase(outR * avg, outInf));
        inArr.push(new KeyframeEase(inR * avg, inInf));
    }
    prop.setTemporalEaseAtKey(k, prop.keyInTemporalEase(k), outArr);
    prop.setTemporalEaseAtKey(k + 1, inArr, prop.keyOutTemporalEase(k + 1));
    return "eased key " + k + "->" + (k + 1);
};
$.global.asmEaseAll = function (prop, c) {
    for (var k = 1; k < prop.numKeys; k++) $.global.asmEase(prop, k, c);
    return prop.numKeys - 1;
};

// 32-bpc projects save almost black PNGs: snapshots switch to 8 bpc for a moment, then back
$.global.asmBpc = function (n) { var old = app.project.bitsPerChannel; if (n && n != old) app.project.bitsPerChannel = n; return old; };

// ------------------------------------------------------------------ Abdulrahman Saad brand identity
// Colors as AE [r, g, b] (0..1), the brand easing as a graph for asmEase / asmEaseAll, and the font names.
function asmHex(h) { return [parseInt(h.substr(1, 2), 16) / 255, parseInt(h.substr(3, 2), 16) / 255, parseInt(h.substr(5, 2), 16) / 255]; }
$.global.asmBrand = {
    dark: asmHex("#1A150D"), dark2: asmHex("#241D13"), ink: asmHex("#2B2214"),
    gold: asmHex("#B0864A"), gold1: asmHex("#8B6B2E"), gold3: asmHex("#D4AF6A"), goldLt: asmHex("#E9C888"),
    cream: asmHex("#FDFBF6"), cream2: asmHex("#F2E4C2"), muted: asmHex("#7A6A4E"), muted2: asmHex("#A3937A"),
    ease: [0.16, 1, 0.3, 1],
    fonts: {
        sans: { 400: "thmanyahsans-Regular", 500: "thmanyahsans-Medium", 700: "thmanyahsans-Bold" },
        serif: { 500: "thmanyahserifdisplay-Medium", 700: "thmanyahserifdisplay-Bold" },
        camel: "TheYearofTheCamel-Regular"
    },
    handle: "@abdulrahman_saad__1", site: "abdulrahmansaad.com",
    nameAr: "\u0639\u0628\u062f\u0627\u0644\u0631\u062d\u0645\u0646 \u0633\u0639\u062f", nameEn: "Abdulrahman Saad",
    role: "VIDEO EDITOR \u2014 MOTION DESIGNER"
};
// Installed fonts whose family / style / PostScript name match a pattern: [{ps, family, style}]
// (AE 24+ has app.fonts; older versions return [] and the PostScript names in asmBrand.fonts are used as they are).
$.global.asmFindFont = function (pattern) {
    var re = (pattern instanceof RegExp) ? pattern : new RegExp(String(pattern), "i"), out = [];
    try {
        var all = app.fonts.allFonts;
        for (var i = 0; i < all.length; i++) {
            var grp = (all[i] instanceof Array) ? all[i] : [all[i]];
            for (var j = 0; j < grp.length; j++) {
                var f = grp[j], ps = String(f.postScriptName), fam = String(f.familyName), st = String(f.styleName);
                if (re.test(ps) || re.test(fam + " " + st)) out.push({ ps: ps, family: fam, style: st });
            }
        }
    } catch (e) {}
    return out;
};
// The PostScript name to use for a brand font on THIS computer: kind "sans" | "serif" | "camel", weight 400 | 500 | 700
$.global.asmBrandFont = function (kind, weight) {
    var B = $.global.asmBrand.fonts, want = kind == "camel" ? B.camel : (B[kind] || B.sans)[weight || 700] || (B[kind] || B.sans)[700];
    var famRe = kind == "camel" ? /year\s*of\s*the\s*camel/i : kind == "serif" ? /thmanyah\s*serif\s*display/i : /thmanyah\s*sans/i;
    var styleRe = weight == 400 ? /regular|book|normal/i : weight == 500 ? /medium|med/i : /bold/i;
    var found = $.global.asmFindFont(famRe), i;
    for (i = 0; i < found.length; i++) if (found[i].ps.toLowerCase() == want.toLowerCase()) return found[i].ps;
    for (i = 0; i < found.length; i++) if (kind == "camel" || styleRe.test(found[i].style) || styleRe.test(found[i].ps)) return found[i].ps;
    return want;
};

// ------------------------------------------------------------------ reading an animation the user made (to learn it)
function asmR3(v) { return Math.round(v * 1000) / 1000; }
function asmVal(v) {
    if (v instanceof Array) { var a = []; for (var i = 0; i < v.length; i++) a.push(typeof v[i] == "number" ? asmR3(v[i]) : String(v[i])); return a; }
    return (typeof v == "number") ? asmR3(v) : (typeof v == "boolean" ? v : String(v));
}
// Each segment between two keys: hold / linear, or its graph in AE terms (influence/speed) and as cubic-bezier.
function asmSegments(p, fd) {
    var out = [], k, j;
    for (k = 1; k < p.numKeys; k++) {
        var t1 = p.keyTime(k), t2 = p.keyTime(k + 1), dt = t2 - t1, oT = p.keyOutInterpolationType(k), iT = p.keyInInterpolationType(k + 1);
        var seg = { fromFrame: Math.round(t1 / fd * 100) / 100, toFrame: Math.round(t2 / fd * 100) / 100 };
        if (oT == KeyframeInterpolationType.HOLD) { seg.graph = "hold"; out.push(seg); continue; }
        if (oT == KeyframeInterpolationType.LINEAR && iT == KeyframeInterpolationType.LINEAR) { seg.graph = "linear"; out.push(seg); continue; }
        var v1 = p.keyValue(k), v2 = p.keyValue(k + 1);
        if (!(v1 instanceof Array)) { v1 = [v1]; v2 = [v2]; }
        if (typeof v1[0] != "number") { seg.graph = "bezier (non-numeric value)"; out.push(seg); continue; }
        var oe = p.keyOutTemporalEase(k), ie = p.keyInTemporalEase(k + 1), d = 0, best = 0;
        if (oe.length == 1) {
            if (v1.length == 1) d = v2[0] - v1[0];
            else { for (j = 0; j < v1.length; j++) d += (v2[j] - v1[j]) * (v2[j] - v1[j]); d = Math.sqrt(d); }
        } else {
            for (j = 0; j < v1.length; j++) if (Math.abs(v2[j] - v1[j]) > Math.abs(v2[best] - v1[best])) best = j;
            d = v2[best] - v1[best];
        }
        var o = oe[oe.length == 1 ? 0 : best], n = ie[ie.length == 1 ? 0 : best], avg = d / dt;
        var x1 = o.influence / 100, x2 = 1 - n.influence / 100;
        var y1 = avg ? x1 * o.speed / avg : 0, y2 = avg ? 1 - (n.influence / 100) * n.speed / avg : 1;
        seg.graph = "bezier";
        seg.ae = { outInfluence: asmR3(o.influence), outSpeed: asmR3(o.speed), inInfluence: asmR3(n.influence), inSpeed: asmR3(n.speed), avgSpeed: asmR3(avg) };
        seg.bezier = [asmR3(x1), asmR3(y1), asmR3(x2), asmR3(y2)];
        out.push(seg);
    }
    return out;
}
function asmEnumName(en, v, names) {
    for (var i = 0; i < names.length; i++) { try { if (en[names[i]] === v) return names[i]; } catch (e) {} }
    return String(v);
}
var FM_BLEND = ["ADD", "SCREEN", "MULTIPLY", "OVERLAY", "SOFT_LIGHT", "HARD_LIGHT", "LIGHTEN", "DARKEN", "LIGHTER_COLOR", "DARKER_COLOR",
    "COLOR_DODGE", "CLASSIC_COLOR_DODGE", "LINEAR_DODGE", "COLOR_BURN", "CLASSIC_COLOR_BURN", "LINEAR_BURN", "VIVID_LIGHT", "LINEAR_LIGHT",
    "PIN_LIGHT", "HARD_MIX", "DIFFERENCE", "CLASSIC_DIFFERENCE", "EXCLUSION", "SUBTRACT", "DIVIDE", "HUE", "SATURATION", "COLOR",
    "LUMINOSITY", "DISSOLVE", "DANCING_DISSOLVE", "STENCIL_ALPHA", "STENCIL_LUMA", "SILHOUETE_ALPHA", "SILHOUETTE_LUMA", "ALPHA_ADD", "LUMINESCENT_PREMUL"];
// Every animated property (keys, graphs, expressions) of the named layers, else the selected ones, else every layer
// of the comp (all = true reads every layer even with a selection), plus how each layer is built (order, parent,
// precomp, blend, matte) and the static values of transforms, cameras, effects and text animators, so an animation
// or a whole way of building can be rebuilt exactly.
$.global.asmReadAnimation = function (compName, names, all) {
    try {
        var comp = $.global.asmComp(compName), fd = comp.frameDuration, list = [], i, how = "named";
        if (names && names.length) { for (i = 0; i < names.length; i++) { try { var Ln = comp.layer(names[i]); if (Ln) list.push(Ln); } catch (e0) {} } }
        else if (!all && comp.selectedLayers.length) { how = "selected"; for (i = 0; i < comp.selectedLayers.length; i++) list.push(comp.selectedLayers[i]); }
        else { how = "all"; for (i = 1; i <= comp.numLayers; i++) list.push(comp.layer(i)); }
        if (!list.length) return JSON.stringify({ ok: false, error: (how == "named" ? "None of these layer names exist in " : "No layers in ") + comp.name + "." });
        var out = { ok: true, comp: comp.name, fps: comp.frameRate, width: comp.width, height: comp.height, frames: Math.round(comp.duration / fd),
            layerCount: comp.numLayers, read: how, layers: [] };
        function walk(g, pathStr, acc) {
            for (var k = 1; k <= g.numProperties; k++) {
                var p = null; try { p = g.property(k); } catch (e1) {}
                if (!p) continue;
                var nm = pathStr + "/" + p.matchName + (p.name != p.matchName ? " (" + p.name + ")" : "");
                if (p.propertyType == PropertyType.PROPERTY) {
                    var animated = false, expr = "";
                    try { animated = p.numKeys > 0; } catch (e2) {}
                    try { if (p.canSetExpression && p.expressionEnabled) expr = p.expression; } catch (e3) {}
                    if (animated || expr) {
                        var e = { path: nm };
                        if (animated) {
                            e.keys = [];
                            for (var q = 1; q <= p.numKeys; q++) e.keys.push([Math.round(p.keyTime(q) / fd * 100) / 100, asmVal(p.keyValue(q))]);
                            try { e.segments = asmSegments(p, fd); } catch (e4) { e.segments = "unreadable: " + e4.toString(); }
                        }
                        if (expr) e.expression = expr;
                        acc.push(e);
                    } else if (pathStr.indexOf("ADBE Effect Parade") >= 0 || pathStr.indexOf("ADBE Text Animators") >= 0 ||
                               pathStr.indexOf("ADBE Transform Group") >= 0 || pathStr.indexOf("ADBE Camera Options Group") >= 0) {
                        try { var v = p.value; if (typeof v == "number" || typeof v == "boolean" || v instanceof Array) acc.push({ path: nm, value: asmVal(v) }); } catch (e5) {}
                    }
                } else walk(p, nm, acc);
            }
        }
        for (i = 0; i < list.length; i++) {
            var L = list[i];
            var info = { name: L.name, index: L.index, type: L.matchName, threeD: !!L.threeDLayer, motionBlur: !!L.motionBlur,
                inFrame: asmR3(L.inPoint / fd), outFrame: asmR3(L.outPoint / fd), parent: L.parent ? L.parent.name : null, effects: [], props: [] };
            if (!L.enabled) info.hidden = true;
            try { if (L.nullLayer) info.isNull = true; } catch (e8) {}
            try { if (L.adjustmentLayer) info.adjustment = true; } catch (e9) {}
            try { if (L.source && L.source instanceof CompItem) info.precomp = L.source.name; } catch (e10) {}
            try { if (L.blendingMode != BlendingMode.NORMAL) info.blend = asmEnumName(BlendingMode, L.blendingMode, FM_BLEND); } catch (e11) {}
            try {
                if (L.trackMatteType != TrackMatteType.NO_TRACK_MATTE) {
                    info.trackMatte = asmEnumName(TrackMatteType, L.trackMatteType, ["ALPHA", "ALPHA_INVERTED", "LUMA", "LUMA_INVERTED"]);
                    try { if (L.trackMatteLayer) info.matteLayer = L.trackMatteLayer.name; } catch (e12) {}
                }
            } catch (e13) {}
            try { var fx = L.property("ADBE Effect Parade"); for (var f = 1; f <= fx.numProperties; f++) info.effects.push(fx.property(f).matchName + " (" + fx.property(f).name + ")"); } catch (e6) {}
            try {
                if (L instanceof TextLayer) {
                    var td = L.property("ADBE Text Properties").property("ADBE Text Document").value;
                    info.text = { text: td.text, font: td.font, size: td.fontSize, tracking: td.tracking, fill: td.applyFill ? asmVal(td.fillColor) : null };
                }
            } catch (e7) {}
            walk(L, "", info.props);
            out.layers.push(info);
        }
        return JSON.stringify(out);
    } catch (e) {
        return JSON.stringify({ ok: false, error: e.toString() });
    }
};

// ------------------------------------------------------------------ entry points called by the panel
// app.effects rebuilds the whole installed-effects list (hundreds with plugins) on EVERY access, so a loop over it
// freezes AE for minutes. Read it once per AE session and reuse it.
$.global.asmEffects = function () {
    if (!$.global.__asmFx) $.global.__asmFx = app.effects;
    return $.global.__asmFx;
};
// asmFindEffect(/lens blur/i) or asmFindEffect("lens blur") -> [{name, matchName, category}]
$.global.asmFindEffect = function (pattern) {
    var re = (pattern instanceof RegExp) ? pattern : new RegExp(String(pattern), "i"), fx = $.global.asmEffects(), r = [];
    for (var i = 0; i < fx.length; i++) if (re.test(fx[i].displayName) || re.test(fx[i].matchName)) r.push({ name: fx[i].displayName, matchName: fx[i].matchName, category: fx[i].category });
    return r;
};

// Run Claude's code as one undo group; always returns a JSON string {ok, result | error, line}.
$.global.asmRun = function (code) {
    code = String(code).replace(/\bapp\.effects\b/g, "asmEffects()");                    // never hit the slow getter in a loop
    app.beginUndoGroup("Abdulrahman Saad Motion");
    try {
        var __r = eval(code), txt;
        if (__r === undefined) txt = "OK (no return value)";
        else { try { txt = (typeof __r == "object" && __r !== null) ? JSON.stringify(__r) : String(__r); } catch (e1) { txt = String(__r); } }
        if (txt.length > 20000) txt = txt.substr(0, 20000) + "\n...(truncated)";
        return JSON.stringify({ ok: true, result: txt });
    } catch (e) {
        return JSON.stringify({ ok: false, error: e.toString(), line: e.line || 0 });
    } finally {
        app.endUndoGroup();
    }
};

// Render ONLY the comp's audio mix (WAV/AIFF output module) for listen_timeline. t0/dur in seconds (null = whole comp).
// Renders just this item (the user's other queue items are paused and restored) and removes it from the queue afterwards.
$.global.asmAudioRender = function (compName, outBase, t0, dur) {
    var item = null;
    try {
        var comp = $.global.asmComp(compName), rq = app.project.renderQueue, i;
        item = rq.items.add(comp);
        var om = item.outputModule(1), T = om.templates, used = null, pick = [];
        for (i = 0; i < T.length; i++) if (/WAV/i.test(T[i])) pick.push(T[i]);
        for (i = 0; i < T.length; i++) if (/AIFF/i.test(T[i])) pick.push(T[i]);
        for (i = 0; i < pick.length && !used; i++) { try { om.applyTemplate(pick[i]); used = pick[i]; } catch (e1) {} }
        if (!used) { try { om.setSettings({ "Format": "WAV" }); used = "WAV (setSettings)"; } catch (e2) {} }
        if (!used) { var names = T.join(", "); item.remove(); item = null; return JSON.stringify({ ok: false, error: "No audio-only output template (WAV/AIFF) in this After Effects. Templates: " + names }); }
        try { om.setSettings({ "Output Audio": "On" }); } catch (e3) {}
        var s0 = (t0 === null || t0 === undefined) ? 0 : t0;
        item.timeSpanStart = s0;
        item.timeSpanDuration = (dur === null || dur === undefined) ? (comp.duration - s0) : Math.min(dur, comp.duration - s0);
        var ext = /AIFF/i.test(used) ? ".aif" : ".wav", p = outBase + ext;
        om.file = new File(p);
        var others = [];
        for (i = 1; i <= rq.numItems; i++) { var it = rq.item(i); if (it !== item) { try { if (it.render) { it.render = false; others.push(it); } } catch (e4) {} } }
        try { rq.render(); } finally { for (i = 0; i < others.length; i++) { try { others[i].render = true; } catch (e5) {} } }
        var f = new File(p);
        if (!f.exists) {                                   // AE may pick its own extension
            var folder = new File(p).parent, stem = new File(outBase).name, list = folder.getFiles(stem + "*");
            for (i = 0; i < list.length; i++) if (list[i] instanceof File && /\.(wav|aif|aiff)$/i.test(list[i].name)) { f = list[i]; break; }
        }
        var res = { ok: f.exists, path: f.fsName, template: used, start: s0, duration: item.timeSpanDuration, fps: comp.frameRate };
        if (!f.exists) res.error = "The audio render produced no file (the comp may have no audio).";
        item.remove(); item = null;
        return JSON.stringify(res);
    } catch (e) {
        try { if (item) item.remove(); } catch (e6) {}
        return JSON.stringify({ ok: false, error: e.toString() });
    }
};
$.global.asmCompInfo = function (compName) {
    try { var c = $.global.asmComp(compName); return JSON.stringify({ ok: true, name: c.name, fps: c.frameRate, duration: c.duration, frames: Math.round(c.duration / c.frameDuration), w: c.width, h: c.height }); }
    catch (e) { return JSON.stringify({ ok: false, error: e.toString() }); }
};

// Render one frame to a PNG (written asynchronously by AE; the panel waits for the file).
$.global.asmSnapshot = function (compName, time, outPath) {
    try {
        var comp = $.global.asmComp(compName);
        var t = (time === null || time === undefined) ? comp.time : time;
        comp.saveFrameToPng(t, new File(outPath));
        return JSON.stringify({ ok: true, comp: comp.name, time: t, width: comp.width, height: comp.height });
    } catch (e) {
        return JSON.stringify({ ok: false, error: e.toString() });
    }
};

"abdulrahman saad motion host loaded";
