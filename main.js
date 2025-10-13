class CsvOneClick extends HTMLElement {
  constructor(){
    super();
    const s = this.attachShadow({mode:'open'});
    s.innerHTML = `
      <style>
        :host{display:block;font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif}
        .card{border:1px solid #e5e7eb;border-radius:12px;padding:16px;box-shadow:0 1px 3px rgba(0,0,0,.05);background:#fff}
        .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
        .grow{flex:1 1 auto}
        .drop{border:2px dashed #cbd5e1;border-radius:12px;padding:18px;margin-top:10px;text-align:center;color:#64748b}
        .drop.drag{border-color:#475569;background:#f8fafc;color:#0f172a}
        .muted{color:#64748b;font-size:12px}
        .big{font-size:22px;font-weight:700;margin:6px 0 0}
        .errors{white-space:pre-wrap;color:#b91c1c;background:#fef2f2;border:1px solid #fecaca;padding:10px;border-radius:10px}
        .ok{color:#065f46;background:#ecfdf5;border:1px solid #a7f3d0;padding:10px;border-radius:10px}
        button{border:1px solid #0ea5e9;background:#0ea5e9;color:#fff;border-radius:10px;padding:8px 12px;font-weight:600;cursor:pointer}
        button[disabled]{opacity:.5;cursor:not-allowed}
        .pill{display:inline-block;padding:2px 8px;border-radius:999px;background:#f1f5f9;color:#0f172a;font-size:12px;border:1px solid #e2e8f0}
        .cols{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px}
        .kvs{display:grid;grid-template-columns:auto 1fr;gap:6px;align-items:center}
        input[type="file"]{border:1px solid #e5e7eb;border-radius:10px;padding:6px;background:#fff}
      </style>

      <div class="card">
        <div class="row">
          <input id="file" type="file" accept=".csv,.txt" />
          <span id="fname" class="pill">kein File</span>
          <span class="muted grow">Ziel-Model: <b id="modelHint">–</b></span>
          <button id="btnUpload" disabled>Upload ins Modell</button>
        </div>

        <div id="drop" class="drop">CSV hierher ziehen (einmal auswählen genügt)</div>

        <div class="cols">
          <div>
            <div class="muted">Zeilen im File (ohne Header):</div>
            <div id="count" class="big">0</div>
          </div>
          <div>
            <div class="muted">Duplikate (Invoice + Position):</div>
            <div id="dup" class="big">0</div>
          </div>
        </div>

        <div id="msg" style="margin-top:12px"></div>
      </div>
    `;

    this._els = {
      file: s.getElementById('file'),
      drop: s.getElementById('drop'),
      fname: s.getElementById('fname'),
      count: s.getElementById('count'),
      dup: s.getElementById('dup'),
      btn: s.getElementById('btnUpload'),
      msg: s.getElementById('msg'),
      modelHint: s.getElementById('modelHint')
    };

    this._text = "";              // Rohinhalt
    this._rows = 0;
    this._dups = [];              // [{invoiceNumber, invoicePosition, count}]
    this._dupCount = 0;
    this._errors = [];            // string[]
    this._fileName = "";
  }

  static get observedAttributes(){ return ["uploadendpoint","modelid","datecolumn","measurecolumn","invoicecol","positioncol","maxmonthsage"]; }
  attributeChangedCallback(){
    this._els.modelHint.textContent = this.getAttribute("modelid") || "–";
  }

  connectedCallback(){
    const {file, drop, btn} = this._els;
    file.addEventListener('change', ()=> this._readFile(file.files && file.files[0]));
    drop.addEventListener('dragover', e=>{ e.preventDefault(); drop.classList.add('drag'); });
    drop.addEventListener('dragleave', ()=> drop.classList.remove('drag'));
    drop.addEventListener('drop', e=>{
      e.preventDefault(); drop.classList.remove('drag');
      this._readFile(e.dataTransfer.files && e.dataTransfer.files[0]);
    });

    btn.addEventListener('click', ()=> this.startUpload());
  }

  // ---------- Public API (Story Script) ----------
  getRowCount(){ return this._rows|0; }
  getFileName(){ return this._fileName||""; }
  getDuplicateCount(){ return this._dupCount|0; }
  getErrorsText(){ return this._errors.join("\n"); }

  // Haupt-Action: Upload (nur wenn gültig)
  startUpload(){
    if (!this._isValid()){
      this._flash("Bitte Fehler beheben, bevor du hochlädst.", "error");
      this.dispatchEvent(new CustomEvent('uploadFailed', { detail: { reason: "invalid" }}));
      return "invalid";
    }
    const endpoint = this.getAttribute("uploadendpoint")||"";
    const modelId  = this.getAttribute("modelid")||"";
    if (!endpoint || !modelId){
      this._flash("Upload-Endpoint/ModelId ist nicht konfiguriert.", "error");
      this.dispatchEvent(new CustomEvent('uploadFailed', { detail: { reason: "config" }}));
      return "config-missing";
    }

    this.dispatchEvent(new CustomEvent('uploadStart', { detail: { fileName: this._fileName, rows: this._rows }}));
    this._els.btn.disabled = true;

    // >>>> HIER: echten Upload via Data Import Service/Proxy aufrufen <<<<
    // Erwartet wird serverseitig: modelId, fileName, fileContent (text oder multipart),
    // optional Mapping/Constanten (z. B. UploadId).
    // Beispiel (Text-POST; passe bei dir an!):
    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        modelId: modelId,
        fileName: this._fileName,
        csv: this._text
      })
    })
    .then(r=> r.ok ? r.json() : Promise.reject(new Error("HTTP "+r.status)))
    .then(res=>{
      this._flash("Upload erfolgreich gestartet/ausgeführt.", "ok");
      this.dispatchEvent(new CustomEvent('uploadDone', { detail: { response: res }}));
      this._els.btn.disabled = false;
      return "ok";
    })
    .catch(err=>{
      this._flash("Upload fehlgeschlagen: "+err.message, "error");
      this.dispatchEvent(new CustomEvent('uploadFailed', { detail: { error: String(err) }}));
      this._els.btn.disabled = false;
      return "error";
    });

    return "started";
  }

  // ---------- Intern ----------
  _readFile(file){
    if(!file) return;
    this._fileName = file.name;
    this._els.fname.textContent = file.name;

    const fr = new FileReader();
    fr.onload = e=>{
      this._text = e.target.result || "";
      this._runValidations();
    };
    fr.readAsText(file);
  }

  _runValidations(){
    // Reset
    this._errors = [];
    this._rows = this._countRows(this._text);
    this._els.count.textContent = String(this._rows);

    // Duplikate (Invoice + Position)
    const dupr = this._scanDuplicates(this._text);
    this._dups = dupr.dups;
    this._dupCount = dupr.count|0;
    this._els.dup.textContent = String(this._dupCount);

    // Fehlermatrix wie in deiner Story
    if (this._rows <= 0){
      this._errors.push("Die Datei enthält keine Datenzeilen.");
    }
    if (this._dupCount > 0){
      const details = JSON.stringify(this._dups).slice(0,1000);
      this._errors.push("Duplikate im CSV gefunden ("+this._dupCount+"). Details: "+details+(details.length===1000?"...":""));
    }

    // Datums-Check (maxMonthsAge)
    const maxMonths = parseInt(this.getAttribute("maxmonthsage")||"1",10) || 1;
    const dateCol   = this.getAttribute("datecolumn")||"Date";
    const measureCol= this.getAttribute("measurecolumn")||"Quantity";

    const dateErrors = this._scanDatesTooOld(this._text, dateCol, measureCol, maxMonths);
    for (let i=0;i<dateErrors.length;i++) this._errors.push(dateErrors[i]);

    // Ausgabe + Button
    this._renderMessage();
    this._els.btn.disabled = !this._isValid();

    // Properties/Events nach außen
    this._emitProps({
      rowCount: this._rows,
      fileName: this._fileName,
      dupCount: this._dupCount,
      errorsText: this._errors.join("\n"),
      isValid: this._isValid()
    });
    this.dispatchEvent(new CustomEvent('validated', { detail: {
      fileName: this._fileName,
      rowCount: this._rows,
      dupCount: this._dupCount,
      isValid: this._isValid(),
      errors: this._errors.slice()
    }}));

    // Wenn alles ok -> Event, damit die Story den DataUpload-Starter öffnen kann
  if (this._isValid()){
  this.dispatchEvent(new CustomEvent('requestUpload', { detail: { fileName: this._fileName }}));
}
  }

  _countRows(text){
    const lines = text.split(/\r\n|\n|\r/);
    let i=0; while(i<lines.length && lines[i].trim()==="") i++;
    if(i>=lines.length) return 0;
    let c=0; for(let j=i+1;j<lines.length;j++){ if(lines[j].trim()!=="") c++; }
    return c;
  }

  _parseCSV(text){
    const lines = text.split(/\r\n|\n|\r/);
    let i=0; while(i<lines.length && lines[i].trim()==="") i++;
    if(i>=lines.length) return { header:[], rows:[] };

    // Delimiter detect
    const cand = [';', ',', '\t', '|'];
    const counts = cand.map(d => (lines[i].match(new RegExp("\\"+d,"g"))||[]).length);
    let delim = ','; let max = -1;
    for (let k=0;k<cand.length;k++){ if(counts[k]>max){ max=counts[k]; delim=cand[k]; } }

    const parseRow = (line) => {
      const out=[]; let cur=''; let inQ=false;
      for(let p=0;p<line.length;p++){
        const ch=line[p];
        if(ch === '"'){
          if(inQ && line[p+1]==='"'){ cur+='"'; p++; } else { inQ=!inQ; }
        }else if(ch===delim && !inQ){
          out.push(cur); cur='';
        }else{
          cur+=ch;
        }
      }
      out.push(cur);
      return out;
    };

    const header = parseRow(lines[i]).map(s=>s.trim());
    const rows = [];
    for(let r=i+1;r<lines.length;r++){
      const raw = lines[r];
      if(!raw || !raw.trim()) continue;
      rows.push(parseRow(raw));
    }
    return { header, rows, delim };
  }

  _scanDuplicates(text){
    const {header, rows} = this._parseCSV(text);
    const name = n => n.toLowerCase().replace(/[\s_]+/g,'');
    const invoiceCol = this.getAttribute("invoicecol")||"Invoice_Number";
    const positionCol= this.getAttribute("positioncol")||"Invoice_position_number";
    const idxInv = header.findIndex(h => name(h) === name(invoiceCol));
    const idxPos = header.findIndex(h => name(h) === name(positionCol));

    if (idxInv < 0 || idxPos < 0) return {count:0,dups:[]};

    const seen = Object.create(null);
    const dups = [];

    for (let r=0;r<rows.length;r++){
      const inv = (rows[r][idxInv]||"").trim();
      const pos = (rows[r][idxPos]||"").trim();
      if(!inv && !pos) continue;
      const key = inv + "|" + pos;
      if (seen[key] == null) seen[key] = 1; else { seen[key] += 1; }
    }

    for (const k in seen){
      if (seen[k] >= 2){
        const [invoiceNumber, invoicePosition] = k.split('|');
        dups.push({ invoiceNumber, invoicePosition, count: seen[k] });
      }
    }
    return { count: dups.length, dups };
  }

_scanDatesTooOld(text, dateColName, measureColName, maxMonths){
  const out = [];
  const {header, rows} = this._parseCSV(text);
  if (!header.length || !rows.length) return out;

  const norm = n => String(n||"").toLowerCase().replace(/[\s_]+/g,'');
  const idxDate = header.findIndex(h => norm(h) === norm(dateColName||"Date"));
  const idxMeas = header.findIndex(h => norm(h) === norm(measureColName||"Quantity"));
  if (idxDate < 0) return out;

  const today = new Date();
  const todayYear = today.getFullYear();
  const todayMonth = today.getMonth() + 1;
  const ym = (y,m)=> y*12 + m;
  const limit = parseInt(maxMonths,10) || 1;

  for (let i=0;i<rows.length;i++){
    // Anker-Measure: Zeilen ohne/nulle Quantity überspringen (wie bei dir)
    if (idxMeas >= 0){
      const rawQ = String(rows[i][idxMeas]||"").trim();
      const q = parseFloat(rawQ.replace(',', '.'));
      if (rawQ === "" || (!isNaN(q) && q === 0)) continue;
    }

    const rawDate = String(rows[i][idxDate]||"").trim();
    if (!rawDate) continue;

    const parsed = parseYMD(rawDate); // {y,m,d, dashed} oder null
    if (!parsed) continue;

    const diff = ym(todayYear, todayMonth) - ym(parsed.y, parsed.m);
    if (diff > limit){
      // Info im Fehlertext im Ziel-Format YYYY-MM-DD ausgeben
      out.push("Date error ("+parsed.dashed+") in row "+(i+2)+ " (CSV)");
    }
  }
  return out;

  function parseYMD(s){
    // 1) YYYYMMDD
    if (/^\d{8}$/.test(s)){
      const y = +s.slice(0,4), m = +s.slice(4,6), d = +s.slice(6,8);
      return { y, m, d, dashed: `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}` };
    }
    // 2) YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)){
      return { y:+s.slice(0,4), m:+s.slice(5,7), d:+s.slice(8,10), dashed: s };
    }
    return null;
  }
}

  _isValid(){ return this._errors.length === 0 && this._rows > 0; }

  _renderMessage(){
    const {msg} = this._els;
    if (this._isValid()){
      msg.innerHTML = `<div class="ok">CSV erkannt: ${this._fileName} — ${this._rows} Zeilen, keine Fehler gefunden.</div>`;
    } else {
      const text = this._errors.join("\n");
      msg.innerHTML = `<div class="errors">${this._escape(text)}</div>`;
    }
  }

  _flash(text, kind){
    const box = document.createElement('div');
    box.className = kind==="ok" ? "ok" : "errors";
    box.textContent = text;
    this._els.msg.innerHTML = "";
    this._els.msg.appendChild(box);
  }

  _emitProps(changes){ this.dispatchEvent(new CustomEvent('propertiesChanged',{detail:{properties:changes}})); }
  _escape(s){ return String(s).replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

// ---- SIGNATUR: rows + minYM + maxYM ----
_getSignature(dateColName, measureColName){
  const {header, rows} = this._parseCSV(this._text);
  const norm = n => String(n||"").toLowerCase().replace(/[\s_]+/g,'');
  const idxDate = header.findIndex(h => norm(h) === norm(dateColName||"Date"));
  const idxMeas = header.findIndex(h => norm(h) === norm(measureColName||"Quantity"));

  let minYM = 999999, maxYM = 0, cnt = 0;

  function parseYMD(s){
    s = String(s||"").trim();
    if (/^\d{8}$/.test(s)) { // YYYYMMDD
      const y = +s.slice(0,4), m = +s.slice(4,6);
      return y*100 + m;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) { // YYYY-MM-DD
      return (+s.slice(0,4))*100 + (+s.slice(5,7));
    }
    return null;
  }

  for (let i=0;i<rows.length;i++){
    if (idxMeas >= 0){
      const rawQ = String(rows[i][idxMeas]||"").trim();
      const q = parseFloat(rawQ.replace(',', '.'));
      if (rawQ === "" || (!isNaN(q) && q === 0)) continue; // wie bei dir
    }
    const rawDate = idxDate>=0 ? String(rows[i][idxDate]||"").trim() : "";
    const ym = parseYMD(rawDate);
    if (ym != null){
      if (ym < minYM) minYM = ym;
      if (ym > maxYM) maxYM = ym;
    }
    cnt++;
  }
  if (minYM === 999999) minYM = 0;
  return { rows: cnt|0, minYM, maxYM, fileName: this._fileName||"" };
}

// Story kann diese Signatur abholen:
getSignatureJson(){
  const dateCol   = this.getAttribute("datecolumn")||"Date";
  const measureCol= this.getAttribute("measurecolumn")||"Quantity";
  const sig = this._getSignature(dateCol, measureCol);
  try { return JSON.stringify(sig); } catch(e){ return "{}"; }
}
  
}
customElements.define('csv-oneclick', CsvOneClick);
