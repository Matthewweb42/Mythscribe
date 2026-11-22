/* ---------- web build: reader links ----------
 * Added by web/scripts/build.mjs, inside Desk's own scope. Send to a reader can give a link instead
 * of a file: the same reading page Desk makes, kept on the server. The reader's notes come back
 * under Revise › Readers › Reader links and go in through Desk's own Bring in notes preview, so they land
 * as reader flags in Review and in the scene's Notes panel, exactly as a notes file does. */
const webRooms = () => (window.__mythscribeWeb && window.__mythscribeWeb.rooms) || null;
async function shareReaderPage(data, html) {
  const R = webRooms(); if (!R || !bookId) return false;
  setSave("Making the link…");
  let token;
  try { ({ token } = await R.create({ bookId, book: data.book, reader: data.reader, file: data.file, html })); }
  catch (e) { setSave("Saved"); toast("Couldn't make the link (" + (e?.code || "error") + "). " + (e?.message || "")); return true; }
  setSave("Saved");
  const link = R.link(token);
  const body = openModal("Reader link for " + data.reader,
    '<p class="hint" style="margin:0 0 10px;line-height:1.5">Send this link to ' + esc(data.reader) + ". They read in any browser and select words to leave a note. Their notes come back to you under Revise › Readers › Reader links.</p>" +
    '<div class="field"><input id="rlLink" type="text" readonly value="' + esc(link) + '" aria-label="Reader link"></div>' +
    '<p class="hint" style="margin:0 0 10px;line-height:1.5">Anyone with the link can read what you sent and leave notes, so send it only to ' + esc(data.reader) + ". You can stop the link at any time.</p>" +
    '<div class="inline"><button class="primary" type="button" id="rlCopy">Copy the link</button><button class="iconbtn" type="button" id="rlDone">Done</button></div>');
  body.querySelector("#rlDone").onclick = closeModal;
  body.querySelector("#rlCopy").onclick = () => copyReaderLink(link, body.querySelector("#rlLink"));
  return true;
}
async function copyReaderLink(link, input) {
  try { await navigator.clipboard.writeText(link); toast("Link copied."); }
  catch { if (input) { input.focus(); input.select(); } toast("Select the link and copy it."); }
}
async function openReaderLinks() {
  const R = webRooms(); if (!R || !book || !bookId) return;
  const body = openModal("Reader links", '<div id="rlList" class="hint">Looking for links…</div>');
  const box = body.querySelector("#rlList");
  let rooms;
  try { rooms = await R.list(bookId); } catch (e) { box.textContent = "Couldn't load the links (" + (e?.code || "error") + ")."; return; }
  if (!rooms.length) { box.textContent = "No reader links for this book yet. Use Send to a reader and pick A reader link."; return; }
  box.className = "cmplist"; box.style.maxHeight = "50vh"; box.style.overflow = "auto";
  box.innerHTML = rooms.map((r) => '<div class="cmprow"><span class="ct"><b>' + esc(r.reader) + '</b><br><small class="hint">' +
    (r.closed ? "Stopped" : "Made " + esc(ago(r.createdAt))) + " · " + r.count + (r.count === 1 ? " note" : " notes") + (r.updatedAt ? ", last " + esc(ago(r.updatedAt)) : "") + "</small></span>" +
    '<span class="inline">' + (r.count ? '<button class="iconbtn" type="button" data-rlin="' + esc(r.token) + '">Bring in notes</button>' : "") +
    (!r.closed ? '<button class="ghost" type="button" data-rlcopy="' + esc(r.token) + '">Copy link</button><button class="ghost" type="button" data-rlstop="' + esc(r.token) + '">Stop link</button>' : "") +
    "</span></div>").join("");
  box.onclick = async (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.rlin) {
      b.disabled = true;
      try { const j = await R.notes(b.dataset.rlin); closeModal(); importPreview(readerJsonNotes(j), { kind: "page", file: "the link for " + (j.reader || "a reader"), reader: j.reader || "" }); }
      catch (er) { b.disabled = false; toast("Couldn't get the notes (" + (er?.code || "error") + ")."); }
    } else if (b.dataset.rlcopy) copyReaderLink(R.link(b.dataset.rlcopy), null);
    else if (b.dataset.rlstop) {
      const token = b.dataset.rlstop;
      if (!(await confirmModal("Stop this link?", "The reader can't open it any more. Notes you've already brought in stay here.", "Stop the link", true))) return;
      try { await R.close(token); toast("Link stopped."); } catch (er) { toast("Couldn't stop the link (" + (er?.code || "error") + ")."); }
    }
  };
}
