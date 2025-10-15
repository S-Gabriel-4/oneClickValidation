class CsvOneClick extends HTMLElement {
  constructor(){
    super();
    const s = this.attachShadow({mode:'open'});
    s.innerHTML = `
      <style>
        :host{display:block;font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif}
        .card{border:1px solid #e5e7eb;border-radius:12px;padding:16px;box-shadow:0 1px 3px rgba(0,0,0,.05);background:#fff}
        .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
        .drop{border:2px dashed #cbd5e1;border-radius:12px;padding:18px;margin-top:10px;text-align:center;color:#64748b}
        .drop.drag{border-color:#475569;background:#f8fafc;color:#0f172a}
        .muted{color:#64748b;font-size:12px}
        .big{font-size:22px;font-weight:700;margin:6px 0 0}
        .errors{white-space:pre-wrap;color:#b91c1c;background:#fef2f2;border:1px solid #fecaca;padding:10px;border-radius:10px}
        .ok{color:#065f46;background:#ecfdf5;border:1px solid #a7f3d0;padding:10px;border-radius:10px}
        .pill{display:inline-block;padding:2px 8px;border-radius:999px;background:#f1f5f9;color:#0f172a;font-size:12px;border:1px solid #e2e8f0}
        .cols{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px}
        .btn{border:1px solid #0ea5e9;background:#0ea5e9;color:#fff;border-radius:10px;padding:8px 12px;font-weight:600;cursor:pointer}
        .btn[disabled]{opacity:.5;cursor:not-allowed}
      </style>

      <div class="card">
        <div class="row">
          <!-- hide native input to remove localized browser text -->
          <input id="file" type="file" accept=".csv,.txt" style="display:none" />
          <button id="pick" type="button" class="btn">Select file</button>
          <span id="fname" class="pill">no file</span>
        </div>

        <div id="drop" class="drop">Drag CSV file here</div>

        <div class="cols">
          <div>
            <div class="muted">Rows in file (without header):</div>
            <div id="count" class="big">0</div>
          </div>
          <div>
            <div class="muted">Duplicates (Invoice + Position):</div>
            <div id="dup" class="big">0</div>
          </div>
        </div>

        <div id="msg" style="margin-top:12px"></div>
      </div>
    `;

    this._els = {
      file:  s.getElementById('file'),
      pick:  s.getElementById('pick'),
      drop:  s.getElementById('drop'),
      fname: s.getElementById('fname'),
      count: s.getElementById('count'),
      dup:   s.getElementById('dup'),
      msg:   s.getElementById('msg')
    };

    // state
    this._text = "";
    this._rows = 0;
    this._dups = [];       // [{invoiceNumber, invoicePosition, count}]
    this._dupCount = 0;
    this._errors = [];
    this._fileName = "";

    // signature values (for SAC script comparison)
    this._sigRows  = 0;
    this._sigMinYM = 0;    // YYYYMM
    this._sigMaxYM = 0;    // YYYYMM
  }

  // only keep attributes relevant for validation
  static get observedAttributes(){ 
    return ["datecolumn","measurecolumn","invoicecol","positioncol","maxmonthsage"];
  }

  connectedCallback(){
    const f = this._els.file, d = this._els.drop, pick = this._els.pick;

    // custom button opens native dialog
    pick.addEventListener('click', function(){ f.click(); });

    f.addEventListener('change', ()=> this._readFile(f.files && f.files[0]));
    d.addEventListener('dragover', e=>{ e.preventDefault(); d.classList.add('drag'); });
    d.addEventListener('dragleave', ()=> d.classList.remove('drag'));
    d.addEventListener('drop', e=>{
      e.preventDefault(); d.classList.remove('drag');
      this._readFile(e.dataTransfer.files && e.dataTransfer.files[0]);
    });
  }

  // ---------- Public API for Story script ----------
  getRowCount(){ return this._rows|0; }
  getFileName(){ return this._fileName||""; }
  getDuplicateCount(){ return this._dupCount|0; }
  getErrorsText(){ return this._errors.join("\n"); }

  // signature getters
  getSigRows(){ return this._sigRows|0; }
  getSigMinYM(){ return this._sigMinYM|0; }
  getSigMaxYM(){ return this._sigMaxYM|0; }

  // ---------- Internal ----------
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
    // reset
    this._errors = [];
    this._rows = this._countRows(this._text);
    this._els.count.textContent = String(this._rows);

    // duplicates (Invoice + Position)
    const dupr = this._scanDuplicates(this._text);
    this._dups = dupr.dups;
    this._dupCount = dupr.count|0;
    this._els.dup.textContent = String(this._dupCount);

    // date check + signature from CSV
    const maxMonths = parseInt(this.getAttribute("maxmonthsage")||"1",10) || 1;
    const dateCol   = this.getAttribute("datecolumn")||"Date";
    const measureCol= this.getAttribute("measurecolumn")||"Quantity";

    const dateInfo = this._scanDatesAndSignature(this._text, dateCol, measureCol, maxMonths);
    var j=0; while(j<dateInfo.errors.length){ this._errors.push(dateInfo.errors[j]); j=j+1; }

    // set signature
    this._sigRows  = this._rows;
    this._sigMinYM = dateInfo.minYM;
    this._sigMaxYM = dateInfo.maxYM;

    // render message
    this._renderMessage();

    // expose to story
    this._emitProps({
      rowCount: this._rows,
      fileName: this._fileName,
      dupCount: this._dupCount,
      errorsText: this._errors.join("\n"),
      isValid: this._errors.length===0 && this._rows>0
    });
    this.dispatchEvent(new CustomEvent('validated', { detail: {
      fileName: this._fileName,
      rowCount: this._rows,
      dupCount: this._dupCount,
      isValid: this._errors.length===0 && this._rows>0,
      errors: this._errors.slice(),
      sigRows: this._sigRows,
      sigMinYM: this._sigMinYM,
      sigMaxYM: this._sigMaxYM
    }}));
  }

  _countRows(text){
    const lines=text.split(/\r\n|\n|\r/);
    let i=0; while(i<lines.length && lines[i].trim()==="") i++;
    if(i>=lines.length) return 0;
    let c=0; for(let j=i+1;j<lines.length;j++){ if(lines[j].trim()!=="") c++; }
    return c;
  }

  _parseCSV(text){
    const lines = text.split(/\r\n|\n|\r/);
    let i=0; while(i<lines.length && lines[i].trim()==="") i++;
    if(i>=lines.length) return { header:[], rows:[] };

    // delimiter detect
    const cand = [';', ',', '\t', '|'];
    const counts = cand.map(d => (lines[i].match(new RegExp("\\"+d,"g"))||[]).length);
    let delim = ','; let max = -1;
    for (let k=0;k<cand.length;k++){ if(counts[k]>max){ max=counts[k]; delim=cand[k]; } }

    const parseRow = (line) => {
      const out=[]; let cur=''; let inQ=false;
      let p=0; while(p<line.length){
        const ch=line[p];
        if(ch === '"'){
          if(inQ && line[p+1]==='"'){ cur+='"'; p=p+2; continue; }
          inQ = !inQ; p=p+1; continue;
        }
        if(ch===delim && !inQ){ out.push(cur); cur=''; p=p+1; continue; }
        cur+=ch; p=p+1;
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
      if (seen[key] == null) seen[key] = 1; else seen[key] = seen[key] + 1;
    }
    for (const k in seen){
      if (seen[k] >= 2){
        const sp = k.split('|');
        dups.push({ invoiceNumber: sp[0], invoicePosition: sp[1], count: seen[k] });
      }
    }
    return { count: dups.length, dups };
  }

  // Date validation + signature (expects CSV date as YYYYMMDD; converts to YYYY-MM-DD for message)
  _scanDatesAndSignature(text, dateColName, measureColName, maxMonths){
    const out = { errors: [], minYM: 0, maxYM: 0 };
    const parsed = this._parseCSV(text);
    const header = parsed.header;
    const rows = parsed.rows;
    if (!header.length) return out;

    const name = n => n.toLowerCase().replace(/[\s_]+/g,'');
    const idxDate = header.findIndex(h => name(h) === name(dateColName));
    const idxMeas = header.findIndex(h => name(h) === name(measureColName));
    if (idxDate < 0) return out;

    const today = new Date();
    const tY = today.getFullYear();
    const tM = today.getMonth()+1;
    const ym = (y,m)=> y*12+m;

    let minYM = 999999, maxYM = 0;

    let i=0; while(i<rows.length){
      if (idxMeas >= 0){
        const meas = (rows[i][idxMeas]||"").trim();
        if (meas === "" || meas === "0") { i=i+1; continue; }
      }

      const raw = (rows[i][idxDate]||"").trim(); // expect YYYYMMDD
      if (/^\d{8}$/.test(raw)) {
        const y = parseInt(raw.slice(0,4),10);
        const m = parseInt(raw.slice(4,6),10);
        const d = parseInt(raw.slice(6,8),10);

        const diff = ym(tY,tM) - ym(y,m);
        if (diff > maxMonths){
          const iso = y + "-" + ("0"+m).slice(-2) + "-" + ("0"+d).slice(-2);
          out.errors.push("Date error (" + iso + ") in row " + (i+2));
        }

        const yym = y*100 + m;
        if (yym < minYM) minYM = yym;
        if (yym > maxYM) maxYM = yym;
      }
      i = i + 1;
    }

    if (minYM === 999999) minYM = 0;
    out.minYM = minYM;
    out.maxYM = maxYM;
    return out;
  }

  _isValid(){ return this._errors.length === 0 && this._rows > 0; }

  _renderMessage(){
    if (this._isValid()){
      this._els.msg.innerHTML = '<div class="ok">CSV detected: ' + this._fileName + ' — ' + this._rows + ' rows, no errors.</div>';
    } else {
      var text = this._errors.join("\n");
      this._els.msg.innerHTML = '<div class="errors">' + this._escape(text) + '</div>';
    }
  }

  _emitProps(changes){ this.dispatchEvent(new CustomEvent('propertiesChanged',{detail:{properties:changes}})); }
  _escape(s){ return String(s).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]); }); }
}

customElements.define('csv-oneclick', CsvOneClick);
