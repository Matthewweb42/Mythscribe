/* ---------- web build: a manuscript from a Word, text or Markdown file on this device ----------
 * Added by web/scripts/build.mjs, inside Desk's own scope, because the web build has no Google
 * Drive. It fills `gd` the way pickDoc does, then Desk's own split, preview and import run. */
function openLocalDocImport(target) {
  gd = { target, id: null, title: "", text: "", split: null };
  const body = openModal(target === "new" ? "New book from a Word file" : "Import a Word file into " + (book?.title || "this book"),
    '<p class="hint" style="margin:0">Pick the Word file (.docx) that holds your manuscript, or a .txt or .md file. It\'s split into chapters and scenes, and you see the split before anything is saved. The file isn\'t changed.</p>' +
    '<input type="file" id="gdFile" accept=".docx,.txt,.md,.markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown" aria-label="Manuscript file">' +
    '<div class="hint" id="gdState" role="status"></div>' +
    '<div id="gdReview" class="picker" hidden><div class="rowhead"><b id="gdTitle"></b></div>' +
    '<label class="field"><span>Find chapters by</span><select id="gdHow"></select></label>' +
    '<div id="gdPreview" class="list" style="max-height:36vh;overflow:auto"></div>' +
    '<div class="inline"><button class="primary" id="gdGo" type="button">' + (target === "new" ? "Create the book" : "Add these chapters") + "</button></div></div>");
  body.querySelector("#gdFile").onchange = (e) => { const f = e.target.files && e.target.files[0]; if (f) pickLocalDoc(f); };
  body.querySelector("#gdHow").onchange = () => resplitDoc();
  body.querySelector("#gdGo").onclick = importDoc;
}
async function pickLocalDoc(f) {
  if (!gd) return;
  gd.id = null; gd.title = f.name.replace(/\.(docx|txt|md|markdown)$/i, ""); $("gdReview").hidden = true;
  gdState("Reading " + f.name + "…");
  try {
    if (/\.doc$/i.test(f.name)) throw new Error("That's an old .doc file. Save it as .docx in Word first.");
    let text;
    if (/\.docx$/i.test(f.name)) { const d = await docxToText(f); text = d.text; if (d.title) gd.title = d.title; }
    else text = await readAs(f, "text");
    gd.text = normalizeDocText(text);
    if (!gd.text.trim()) throw new Error("That file has no text I can read.");
    const heads = splitDoc(gd.text, "headings"), lines = splitDoc(gd.text, "lines");
    const opts = [];
    if (heads.chapters.length >= 2) opts.push(["headings", "Headings (" + heads.chapters.length + " chapters)"]);
    if (lines.chapters.length >= 2) opts.push(["lines", "Lines like “Chapter 1” (" + lines.chapters.length + " chapters)"]);
    if (sample) opts.push(["ai", "Let " + persona() + " find the chapters"]);
    opts.push(["one", "Keep it as one chapter"]);
    $("gdHow").innerHTML = opts.map(([v, l]) => '<option value="' + v + '">' + esc(l) + "</option>").join("");
    $("gdTitle").textContent = gd.title + " · " + fmt(words(gd.text)) + " words";
    $("gdReview").hidden = false; gdState("");
    resplitDoc();
  } catch (e) { gdState((e && e.message) || "Couldn't read that file.", true); }
}
/* A .docx as the text Desk's importer expects: "#" headings from Word's heading styles, a blank
 * line between paragraphs, *italic* runs kept. */
async function docxToText(f) {
  await needLib("zip");
  const zip = await window.JSZip.loadAsync(await readAs(f, "buf"));
  const file = zip.file("word/document.xml");
  if (!file) throw new Error("That doesn't look like a Word file.");
  return docxXmlToText(await file.async("string"));
}
/** The manuscript as Markdown-ish text ("#" headings, *italics*), and the Title-style line, if any, as the book's title. */
function docxXmlToText(xml) {
  const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const kids = (el, name) => [...el.childNodes].filter((n) => n.namespaceURI === W && n.localName === name);
  const on = (rPr, name) => { const el = rPr && kids(rPr, name)[0]; if (!el) return false; const v = el.getAttributeNS(W, "val"); return v !== "0" && v !== "false" && v !== "none"; };
  const out = [];
  let title = "";
  for (const p of doc.getElementsByTagNameNS(W, "p")) {
    const pPr = kids(p, "pPr")[0];
    const style = ((pPr && kids(pPr, "pStyle")[0]) || null)?.getAttributeNS(W, "val") || "";
    const outline = ((pPr && kids(pPr, "outlineLvl")[0]) || null)?.getAttributeNS(W, "val");
    let level = 0;
    const hm = /^heading\s*([1-6])$/i.exec(style);
    const isTitle = /^title$/i.test(style);
    if (hm) level = +hm[1]; else if (!isTitle && outline != null && +outline < 6) level = +outline + 1;
    const segs = [];
    const runs = [...p.getElementsByTagNameNS(W, "r")];
    for (const r of runs) {
      const rPr = kids(r, "rPr")[0], it = !level && on(rPr, "i");
      let t = "";
      for (const n of r.childNodes) {
        if (n.namespaceURI !== W) continue;
        if (n.localName === "t") t += n.textContent;
        else if (n.localName === "tab") t += "\t";
        else if (n.localName === "br" && n.getAttributeNS(W, "type") !== "page") t += " ";
      }
      if (!t) continue;
      const last = segs[segs.length - 1];
      if (last && last.it === it) last.t += t; else segs.push({ it, t });
    }
    let line = segs.map((s) => { if (!s.it || !s.t.trim()) return s.t; const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s.t); return m[1] + "*" + m[2] + "*" + m[3]; }).join("").replace(/\s+$/, "");
    if (isTitle) { if (!title && !out.some((l) => l.trim())) title = line.replace(/\*/g, "").trim(); else if (line.trim()) out.push("# " + line.replace(/\*/g, "").trim()); continue; }
    if (level && line.trim()) line = "#".repeat(level) + " " + line.trim();
    out.push(line);
  }
  return { text: out.join("\n\n").replace(/\n{3,}/g, "\n\n").trim() + "\n", title };
}
