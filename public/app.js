const { useState, useEffect, useRef, useCallback, useMemo } = React;

/* ─── helpers ──────────────────────────────────────────────────────────── */

function parseField(text, field) {
  const m = (text || '').match(new RegExp(field + ':\\s*([\\s\\S]+?)(?=\\n[A-Z_]+:|$)'));
  return m ? m[1].trim() : '';
}
function parseFindings(text) {
  return (text||'').split('---').map(b=>b.trim()).filter(Boolean).map(b=>({
    finding: parseField(b,'FINDING'), value: parseField(b,'VALUE'),
    context: parseField(b,'CONTEXT'), significance: parseField(b,'SIGNIFICANCE'),
  })).filter(f=>f.finding);
}
function parseRisks(text) {
  return (text||'').split('---').map(b=>b.trim()).filter(Boolean).map(b=>({
    riskItem: parseField(b,'RISK_ITEM'),
    severity: (parseField(b,'SEVERITY')||'').toUpperCase(),
    description: parseField(b,'DESCRIPTION'),
    implication: parseField(b,'CLINICAL_IMPLICATION'),
  })).filter(r=>r.riskItem);
}
function parseRecos(text) {
  return (text||'').split('---').map(b=>b.trim()).filter(Boolean).map(b=>({
    recommendation: parseField(b,'RECOMMENDATION'),
    patientProfile: parseField(b,'PATIENT_PROFILE'),
    dosage: parseField(b,'DOSAGE_OR_PROTOCOL'),
    monitoring: parseField(b,'MONITORING'),
    contraindication: parseField(b,'CONTRAINDICATION'),
    evidenceStrength: (parseField(b,'EVIDENCE_STRENGTH')||'').toUpperCase(),
  })).filter(r=>r.recommendation);
}
function parseSynthesis(text) {
  const t = text || '';
  return {
    verdict: parseField(t,'CLINICAL_VERDICT'), reasoning: parseField(t,'VERDICT_REASONING'),
    keyFinding: parseField(t,'KEY_FINDING'),   population: parseField(t,'PATIENT_POPULATION'),
    action: parseField(t,'RECOMMENDED_ACTION'), caution: parseField(t,'CAUTION'),
    step1: parseField(t,'STEP_1'), step2: parseField(t,'STEP_2'), step3: parseField(t,'STEP_3'),
    priorityRisk: parseField(t,'PRIORITY_RISK'),
  };
}
function formatBytes(b) {
  if (b<1024) return b+' B';
  if (b<1048576) return (b/1024).toFixed(1)+' KB';
  return (b/1048576).toFixed(1)+' MB';
}
function delay(ms) { return new Promise(r=>setTimeout(r,ms)); }

/* ─── icons ────────────────────────────────────────────────────────────── */

function SVGIcon({ d, size = 16, className = "", color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      {d}
    </svg>
  );
}

const icons = {
  shieldAlert: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></>,
  alertTriangle: <><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></>,
  zap: <><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></>,
  info: <><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></>,
  fileText: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></>,
  uploadCloud: <><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M12 12v9"/><path d="m16 16-4-4-4 4"/></>,
  layoutList: <><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/><path d="M14 4h7"/><path d="M14 9h7"/><path d="M14 15h7"/><path d="M14 20h7"/></>,
  activity: <><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></>,
  layers: <><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></>,
  search: <><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></>,
  database: <><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/></>,
  xCircle: <><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></>,
  checkCircle: <><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></>,
  check: <><polyline points="20 6 9 17 4 12"/></>,
  x: <><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></>,
  microscope: <><path d="M6 18h8"/><path d="M3 22h18"/><path d="M14 22a7 7 0 1 0 0-14h-1"/><path d="M9 14h2"/><path d="M9 12a2 2 0 0 1-2-2V6h6v4a2 2 0 0 1-2 2Z"/><path d="M12 6V3a1 1 0 0 0-1-1H9a1 1 0 0 0-1 1v3"/></>,
};

/* ─── design tokens ────────────────────────────────────────────────────── */

const SEV = {
  CRITICAL: { bg:'#FEF2F2', border:'#FECACA', badge:'#DC2626', text:'#991B1B', icon: <SVGIcon d={icons.shieldAlert} size={14} color="#DC2626" /> },
  HIGH:     { bg:'#FFF7ED', border:'#FED7AA', badge:'#EA580C', text:'#9A3412', icon: <SVGIcon d={icons.alertTriangle} size={14} color="#EA580C" /> },
  MEDIUM:   { bg:'#FFFBEB', border:'#FDE68A', badge:'#D97706', text:'#B45309', icon: <SVGIcon d={icons.zap} size={14} color="#D97706" /> },
  LOW:      { bg:'#F0FDF4', border:'#BCF0DA', badge:'#16A34A', text:'#166534', icon: <SVGIcon d={icons.info} size={14} color="#16A34A" /> },
};
const EV = {
  STRONG:   { bg:'#F0FDF4', color:'#16A34A', border:'#BBF7D0' },
  MODERATE: { bg:'#FFFBEB', color:'#D97706', border:'#FDE68A' },
  WEAK:     { bg:'#FEF2F2', color:'#DC2626', border:'#FECACA' },
};
const VERDICT_CFG = {
  'STRONG EVIDENCE':       { color:'#166534', bg:'#DCFCE7', border:'#86EFAC', short:'STRONG' },
  'MODERATE EVIDENCE':     { color:'#9A3412', bg:'#FEF3C7', border:'#FCD34D', short:'MODERATE' },
  'LIMITED EVIDENCE':      { color:'#9A3412', bg:'#FFEDD5', border:'#FDBA74', short:'LIMITED' },
  'INSUFFICIENT EVIDENCE': { color:'#374151', bg:'#F3F4F6', border:'#D1D5DB', short:'INSUFFICIENT' },
};

/* ─── primitives ────────────────────────────────────────────────────────── */

function Spinner({ size=16, color='#6B7280' }) {
  return <div style={{
    width:size, height:size, flexShrink:0,
    border:`2px solid ${color}40`, borderTopColor:color,
    borderRadius:'50%', animation:'spin .6s linear infinite', display:'inline-block',
  }}/>;
}

function Badge({ children, bg='#F3F4F6', color='#374151', style={} }) {
  return <span style={{
    display:'inline-flex', alignItems:'center',
    background:bg, color, fontSize:'0.75rem', fontWeight:600,
    letterSpacing:'0.02em', padding:'2px 8px', borderRadius:'4px', whiteSpace:'nowrap', ...style
  }}>{children}</span>;
}

function Card({ children, style, className }) {
  return <div className={`card ${className||''}`} style={{
    background:'#fff', border:'1px solid #E5E7EB', borderRadius:'8px',
    boxShadow:'0 1px 2px 0 rgba(0,0,0,0.05)', ...style,
  }}>{children}</div>;
}

function SectionTitle({ title, sub }) {
  return <div style={{ marginBottom:20 }}>
    <h2 style={{ fontSize:'1.125rem', fontWeight:600, color:'#111827', letterSpacing:'-0.01em' }}>{title}</h2>
    {sub && <p style={{ fontSize:'0.875rem', color:'#6B7280', marginTop:4 }}>{sub}</p>}
  </div>;
}

function InfoBox({ label, children, accent }) {
  return <div style={{
    background: accent ? '#F8FAFC' : '#F9FAFB',
    border:`1px solid ${accent ? '#E2E8F0' : '#E5E7EB'}`,
    borderRadius:'6px', padding:'16px',
    borderLeft: accent ? '3px solid #0F172A' : '1px solid #E5E7EB'
  }}>
    <div style={{ fontSize:'0.75rem', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.04em', color:'#6B7280', marginBottom:8 }}>{label}</div>
    <div style={{ fontSize:'0.875rem', color: '#111827', lineHeight:1.6, fontWeight: accent ? 500 : 400 }}>{children}</div>
  </div>;
}

/* ─── Header ────────────────────────────────────────────────────────────── */

function Header() {
  return <header style={{
    background:'#FFFFFF',
    padding:'16px 32px', color:'#111827',
    borderBottom:'1px solid #E5E7EB',
    boxShadow: '0 1px 2px 0 rgba(0,0,0,0.03)'
  }}>
    <div style={{ maxWidth:1200, margin:'0 auto', display:'flex', alignItems:'center', gap:16 }}>
      <div style={{
        width:40, height:40, borderRadius:'6px', flexShrink:0,
        background:'#F1F5F9', border:'1px solid #E2E8F0',
        display:'flex', alignItems:'center', justifyContent:'center',
      }}>
        <SVGIcon d={icons.microscope} size={20} color="#0F172A" />
      </div>
      <div>
        <h1 style={{ fontSize:'1.125rem', fontWeight:600, letterSpacing:'-0.015em', color: '#0F172A' }}>
          Medical Research Summarizer
        </h1>
        <p style={{ fontSize:'0.875rem', color:'#6B7280', marginTop:2 }}>
          Multi-agent analysis · Orchestrator task assignment · Clinical RAG
        </p>
      </div>
    </div>
  </header>;
}

/* ─── DropZone ──────────────────────────────────────────────────────────── */

function DropZone({ file, onFile, onRemove }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);

  const handleDrop = useCallback(e => {
    e.preventDefault(); setDragging(false);
    if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]);
  }, [onFile]);

  return <div
    onClick={() => !file && inputRef.current?.click()}
    onDragOver={e => { e.preventDefault(); setDragging(true); }}
    onDragLeave={() => setDragging(false)}
    onDrop={handleDrop}
    style={{
      border:`1px dashed ${dragging ? '#0F172A' : file ? '#10B981' : '#D1D5DB'}`,
      borderRadius:'6px', padding:'32px 24px', textAlign:'center',
      cursor: file ? 'default' : 'pointer',
      background: dragging ? '#F8FAFC' : file ? '#F0FDF4' : '#F9FAFB',
      transition:'all .15s',
    }}
  >
    <input ref={inputRef} type="file" accept=".pdf,.txt" style={{ display:'none' }}
      onChange={e => e.target.files[0] && onFile(e.target.files[0])} />

    <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
      {file ? <div style={{padding: '12px', background: '#D1FAE5', borderRadius: '50%'}}>
        <SVGIcon d={icons.fileText} size={24} color="#059669"/>
      </div> : <div style={{padding: '12px', background: '#E2E8F0', borderRadius: '50%'}}>
        <SVGIcon d={icons.uploadCloud} size={24} color="#475569"/>
      </div>}
    </div>

    {file ? (
      <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:8 }}>
        <p style={{ fontWeight:500, color:'#111827', fontSize:'0.875rem' }}>{file.name}</p>
        <p style={{ color:'#6B7280', fontSize:'0.75rem' }}>{formatBytes(file.size)}</p>
        <button onClick={e => { e.stopPropagation(); onRemove(); }} style={{
          background:'transparent', color:'#EF4444', border:'1px solid #FECACA', borderRadius:'4px',
          padding:'4px 12px', fontSize:'0.75rem', fontWeight:500,
          marginTop: 8, transition:'background .15s',
          display: 'flex', alignItems: 'center', gap: 6
        }} className="hover-red"><SVGIcon d={icons.x} size={12} color="currentColor"/> Remove file</button>
      </div>
    ) : (
      <>
        <p style={{ fontWeight:500, color:'#111827', fontSize:'0.875rem' }}>Click or drag file to this area to upload</p>
        <p style={{ color:'#6B7280', fontSize:'0.75rem', marginTop:4 }}>
          Supports PDF or plain text
        </p>
      </>
    )}
  </div>;
}

/* ─── UploadCard ────────────────────────────────────────────────────────── */

function UploadCard({ onAnalyze, loading }) {
  const [file, setFile]         = useState(null);
  const [text, setText]         = useState('');
  const [error, setError]       = useState('');
  const [sampling, setSampling] = useState(false);

  async function loadSample() {
    setSampling(true); setError('');
    try {
      const r = await fetch('/api/sample');
      const d = await r.json();
      setText(d.text); setFile(null);
    } catch(e) { setError('Could not load sample: ' + e.message); }
    finally { setSampling(false); }
  }

  function submit() {
    setError('');
    if (!file && !text.trim()) { setError('Please upload a document or provide text.'); return; }
    onAnalyze({ file, text });
  }

  return <Card style={{ padding:28 }}>
    <SectionTitle
      title="Document Input"
      sub="Upload a clinical trial, meta-analysis, or medical observation document."
    />

    <DropZone file={file} onFile={f => { setFile(f); setText(''); }} onRemove={() => setFile(null)} />

    <div style={{ display:'flex', alignItems:'center', gap:16, margin:'24px 0', color:'#9CA3AF', fontSize:'0.75rem', textTransform:'uppercase', letterSpacing:'0.04em' }}>
      <div style={{ flex:1, height:1, background:'#E5E7EB' }}/>
      Or manual entry
      <div style={{ flex:1, height:1, background:'#E5E7EB' }}/>
    </div>

    <textarea rows={6}
      placeholder="Paste the abstract or full text of a medical research paper..."
      value={text}
      onChange={e => { setText(e.target.value); if (e.target.value) setFile(null); }}
      disabled={!!file}
    />

    {error && <div style={{
      marginTop:16, padding:'12px 16px',
      background:'#FEF2F2', border:'1px solid #FCA5A5',
      borderRadius:'6px', fontSize:'0.875rem', color:'#991B1B', display: 'flex', gap: 8, alignItems: 'center'
    }}><SVGIcon d={icons.alertTriangle} size={16} color="#991B1B"/> {error}</div>}

    <div style={{ display:'flex', gap:12, marginTop:24, flexWrap:'wrap', justifyContent: 'flex-end' }}>
      <button onClick={loadSample} disabled={sampling || loading} className="btn-secondary" style={{
        background:'#FFFFFF', color:'#374151',
        border:'1px solid #D1D5DB', borderRadius:'6px',
        padding:'8px 16px', fontSize:'0.875rem', fontWeight:500,
        display:'flex', alignItems:'center', gap:8,
      }}>
        {sampling ? <Spinner size={14} color="#6B7280"/> : <SVGIcon d={icons.fileText} size={16} />}
        Load sample paper
      </button>
      <button onClick={submit} disabled={loading} className="btn-primary" style={{
        background: loading ? '#475569' : '#0F172A', color:'#fff',
        border: '1px solid transparent',
        borderRadius:'6px', padding:'8px 20px', fontSize:'0.875rem', fontWeight:500,
        display:'flex', alignItems:'center', gap:8, transition:'background .15s',
      }}>
        {loading ? <Spinner size={16} color="#fff"/> : <SVGIcon d={icons.activity} size={16}/>}
        {loading ? 'Analyzing...' : 'Execute Analysis'}
      </button>
    </div>
  </Card>;
}

/* ─── PipelineSteps ─────────────────────────────────────────────────────── */

const STEP_LABELS = [
  'Extracting text and normalizing input',
  'Validating document eligibility against medical parameters',
  'Orchestrating agent tasks based on specific context',
  'Vector embedding & RAG retrieval · Dispatching specialized agents',
];

function StepRow({ number, label, status, detail }) {
  const cfg = {
    idle:    { bg:'#F9FAFB', border:'#E5E7EB', iconColor:'#9CA3AF', iconBg:'#F3F4F6' },
    loading: { bg:'#F8FAFC', border:'#CBD5E1', iconColor:'#0F172A', iconBg:'#E2E8F0' },
    pass:    { bg:'#F0FDF4', border:'#BBF7D0', iconColor:'#059669', iconBg:'#D1FAE5' },
    fail:    { bg:'#FEF2F2', border:'#FECACA', iconColor:'#DC2626', iconBg:'#FEE2E2' },
  }[status] || { bg:'#F9FAFB', border:'#E5E7EB', iconColor:'#9CA3AF', iconBg:'#F3F4F6' };

  return <div style={{
    display:'flex', alignItems:'center', gap:16,
    padding:'12px 16px', borderRadius:'6px',
    background:cfg.bg, border:`1px solid ${cfg.border}`,
    transition:'all .2s ease',
  }}>
    <div style={{
      width:28, height:28, borderRadius:'50%', flexShrink:0,
      background:cfg.iconBg, color:cfg.iconColor,
      display:'flex', alignItems:'center', justifyContent:'center',
      fontSize:'0.75rem', fontWeight:600,
    }}>
       {status === 'loading' ? <Spinner size={14} color="#0F172A"/>
       : status === 'pass'  ? <SVGIcon d={icons.check} size={14} color="#059669"/>
       : status === 'fail'  ? <SVGIcon d={icons.x} size={14} color="#DC2626"/>
       : number}
    </div>
    <div style={{ flex:1, minWidth:0 }}>
      <div style={{ fontWeight:500, fontSize:'0.875rem', color:'#111827' }}>{label}</div>
      {detail && <div style={{ fontSize:'0.75rem', color:'#6B7280', marginTop:2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{detail}</div>}
    </div>
  </div>;
}

function PipelineSteps({ steps }) {
  return <Card className="fade-in" style={{ padding:28 }}>
    <SectionTitle title="Analysis Pipeline" sub="Automated workflow executing parallel agent validation and data extraction." />
    <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
      {STEP_LABELS.map((label, i) => (
        <StepRow key={i} number={i+1} label={label} {...(steps[i] || { status:'idle', detail:'Pending...' })} />
      ))}
    </div>
  </Card>;
}

/* ─── RejectionBanner ───────────────────────────────────────────────────── */

function RejectionBanner({ data }) {
  return <div className="fade-in" style={{
    background:'#FEF2F2', border:'1px solid #FCA5A5',
    borderRadius:'8px', padding:'24px',
  }}>
    <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:16 }}>
      <SVGIcon d={icons.xCircle} size={24} color="#DC2626" />
      <h3 style={{ color:'#991B1B', fontWeight:600, fontSize:'1.125rem', margin: 0 }}>Document Analysis Rejected</h3>
    </div>
    <div style={{ display:'flex', flexDirection:'column', gap:8, fontSize:'0.875rem', color:'#991B1B', lineHeight:1.6 }}>
      <p style={{ display: 'grid', gridTemplateColumns: '120px 1fr' }}><strong style={{fontWeight:600}}>Detected type:</strong> <span>{data.documentType}</span></p>
      <p style={{ display: 'grid', gridTemplateColumns: '120px 1fr' }}><strong style={{fontWeight:600}}>Reason:</strong> <span>{data.reason}</span></p>
      {data.missing && <p style={{ display: 'grid', gridTemplateColumns: '120px 1fr' }}><strong style={{fontWeight:600}}>Missing elements:</strong> <span>{data.missing}</span></p>}
    </div>
    <div style={{ marginTop:20, padding:'12px 16px', background:'#FFFFFF', border: '1px solid #FECACA', borderRadius:'6px', fontSize:'0.75rem', color:'#7F1D1D', lineHeight:1.5 }}>
      <strong>Accepted formats:</strong> Clinical Trial, Meta-Analysis, Systematic Review, Observational Study, Case Study, or Pharmacological Study.
    </div>
  </div>;
}

/* ─── OrchestratorPanel ─────────────────────────────────────────────────── */

const AGENT_SCHEMES = [
  { key: 'extractor',      badge:'Agent 1', title:'Clinical Data Extractor',         taskKey:'agent1Task' },
  { key: 'risk',           badge:'Agent 2', title:'Risk & Limitations Analyzer',     taskKey:'agent2Task' },
  { key: 'recommendation', badge:'Agent 3', title:'Treatment Guide Writer',          taskKey:'agent3Task' },
];

function AgentTaskCard({ scheme, task }) {
  return <div
    style={{
      background:'#fff', border:'1px solid #E5E7EB',
      borderRadius:'6px', padding:20,
    }}
  >
    <div style={{display:'flex', alignItems:'center', gap: '8px', marginBottom: 12}}>
      <Badge>{scheme.badge}</Badge>
      <div style={{ fontWeight:600, fontSize:'0.875rem', color:'#111827' }}>{scheme.title}</div>
    </div>
    <div style={{ fontSize:'0.8125rem', color:'#4B5563', lineHeight:1.6, whiteSpace:'pre-wrap', wordBreak:'break-word' }}>{task || 'No task defined.'}</div>
  </div>;
}

function OrchestratorPanel({ plan }) {
  return <Card className="fade-in" style={{ padding:28 }}>
    <SectionTitle
      title="Dynamic Orchestration Plan"
      sub="Task delegation formulated by orchestrator specifically for this document context."
    />
    <div className="grid-3">
      {AGENT_SCHEMES.map((s) => <AgentTaskCard key={s.taskKey} scheme={s} task={plan[s.taskKey]} />)}
    </div>
  </Card>;
}

/* ─── PaperInfoBar ──────────────────────────────────────────────────────── */

function Pill({ icon, label }) {
  return <span style={{
    display:'inline-flex', alignItems:'center', gap:8,
    background:'#F9FAFB', border:'1px solid #E5E7EB',
    borderRadius:'6px', padding:'6px 12px',
    fontSize:'0.75rem', fontWeight:500, color:'#374151', whiteSpace:'nowrap',
  }}><SVGIcon d={icon} size={14} color="#6B7280"/> {label}</span>;
}

function PaperInfoBar({ data }) {
  return <div className="fade-in" style={{ display:'flex', flexWrap:'wrap', gap:12, padding:'8px 0' }}>
    <Pill icon={icons.layoutList} label={data.paperType}/>
    <Pill icon={icons.activity} label={data.diseaseOrDrug}/>
    <Pill icon={icons.layers} label={`${data.chunkCount} document segments`}/>
    <Pill icon={icons.search} label={`Top-${data.ragInfo?.topK} RAG Retrieval`}/>
    <Pill icon={icons.database} label="In-memory Vector Store"/>
  </div>;
}

/* ─── AgentOutputSection ────────────────────────────────────────────────── */

const AGENT_OUTPUT_DEFS = [
  { key:'extractor',     title:'Data Extractor Module',        desc:'Raw extraction of trial results, dosages, and statistics.', border: '#3B82F6' },
  { key:'risk',          title:'Risk Analyzer Module',         desc:'Identification of adverse events, limits, and safety signals.', border: '#EF4444' },
  { key:'recommendation',title:'Treatment Protocol Writer',    desc:'Actionable prescribing guidance synthesized from evidence.', border: '#10B981' },
];

function AgentOutputCard({ def, output, index }) {
  return <div className="fade-in" style={{ background: '#fff', border:'1px solid #E5E7EB', borderTop: `2px solid ${def.border}`, borderRadius: '6px', padding: '20px' }}>
    <div style={{ fontWeight:600, fontSize:'0.875rem', color:'#111827', marginBottom:4 }}>{def.title}</div>
    <div style={{ fontSize:'0.75rem', color:'#6B7280', marginBottom:16, lineHeight:1.5 }}>{def.desc}</div>
    <div style={{
      background:'#111827', borderRadius:'4px',
      padding:'12px', fontFamily:'"SF Mono", "Fira Code", monospace',
      fontSize:'0.75rem', lineHeight:1.6, whiteSpace:'pre-wrap', wordBreak:'break-word',
      maxHeight:240, overflowY:'auto', color:'#D1D5DB',
    }} className="scrollbar-dark">{output || 'Null'}</div>
  </div>;
}

function AgentOutputSection({ agents }) {
  return <Card className="fade-in" style={{ padding: 28 }}>
     <SectionTitle title="Raw Agent Telemetry" sub="Logs directly sourced from parallel processing nodes." />
    <div className="grid-3">
      {AGENT_OUTPUT_DEFS.map((d, i) => (
        <AgentOutputCard key={d.key} def={d} output={agents[d.key]} index={i}/>
      ))}
    </div>
  </Card>
}

/* ─── ClinicalSummary tabs ──────────────────────────────────────────────── */

/* Verdict tab */
function VerdictBadge({ verdict }) {
  const cfg = VERDICT_CFG[verdict] || VERDICT_CFG['INSUFFICIENT EVIDENCE'];
  return <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24, padding: '16px', background: cfg.bg, border: `1px solid ${cfg.border}`, borderRadius: '6px' }}>
    <div style={{ color: cfg.color, fontWeight: 700, fontSize: '0.875rem', letterSpacing: '0.02em'}}>{verdict}</div>
  </div>;
}

function ActionStep({ number, text }) {
  return <div style={{
    display:'flex', alignItems:'flex-start', gap:12,
    padding:'12px 16px', background:'#FFFFFF',
    border:'1px solid #E5E7EB', borderRadius:'6px',
    fontSize:'0.875rem', color:'#111827', lineHeight:1.5,
  }}>
    <div style={{
      width:24, height:24, borderRadius:'50%',
      background:'#F1F5F9', border: '1px solid #E2E8F0', color:'#0F172A',
      display:'flex', alignItems:'center', justifyContent:'center',
      fontSize:'0.75rem', fontWeight:600, flexShrink:0,
    }}>{number}</div>
    <div style={{paddingTop: 2}}>{text}</div>
  </div>;
}

function VerdictTab({ syn }) {
  return <div className="fade-in" style={{ display:'flex', flexDirection:'column', gap:16 }}>
    <VerdictBadge verdict={syn.verdict}/>
    <InfoBox label="Verdict Definition">{syn.reasoning}</InfoBox>
    <div className="grid-2">
      <InfoBox label="Primary Finding">
        <span style={{ fontWeight:600, fontSize:'0.875rem' }}>{syn.keyFinding}</span>
      </InfoBox>
      <InfoBox label="Target Population">{syn.population}</InfoBox>
    </div>
    <InfoBox label="Recommended Course of Action" accent>{syn.action}</InfoBox>
    
    {syn.caution && <div style={{ background:'#FFFBEB', border:'1px solid #FDE68A', borderRadius:'6px', padding:'16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize:'0.75rem', fontWeight:600, textTransform:'uppercase', color:'#B45309', marginBottom:8 }}><SVGIcon d={icons.alertTriangle} size={14} color="#B45309"/> Observation Caution</div>
      <div style={{ fontSize:'0.875rem', color:'#9A3412', lineHeight:1.6 }}>{syn.caution}</div>
    </div>}
    
    <div>
      <div style={{ fontSize:'0.75rem', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.04em', color:'#6B7280', marginBottom:12, marginTop: 8 }}>Implementation Steps</div>
      <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
        {[syn.step1, syn.step2, syn.step3].filter(Boolean).map((s, i) => <ActionStep key={i} number={i+1} text={s}/>)}
      </div>
    </div>
    
    {syn.priorityRisk && <div style={{ background:'#FEF2F2', border:'1px solid #FECACA', borderRadius:'6px', padding:'16px' }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize:'0.75rem', fontWeight:600, textTransform:'uppercase', color:'#DC2626', marginBottom:8 }}><SVGIcon d={icons.shieldAlert} size={14} color="#DC2626"/> Priority Patient Risk</div>
      <div style={{ fontSize:'0.875rem', color:'#991B1B', lineHeight:1.6 }}>{syn.priorityRisk}</div>
    </div>}
  </div>;
}

/* Data tab */
function FindingCard({ finding, value, context, significance }) {
  return <div
    style={{
      background:'#fff', border:'1px solid #E5E7EB', borderRadius:'6px', padding:20,
    }}
  >
    <div style={{ fontSize:'0.65rem', fontWeight:700, color:'#6B7280', textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:8 }}>{finding}</div>
    <div style={{ fontSize:'1.125rem', fontWeight:600, color:'#111827', marginBottom:8 }}>{value}</div>
    <div style={{ fontSize:'0.8125rem', color:'#4B5563', lineHeight:1.5 }}>{context}</div>
    {significance && significance !== 'NOT REPORTED' && (
      <div style={{ marginTop:12, display:'inline-block', background:'#F3F4F6', color:'#374151', borderRadius:'4px', padding:'4px 8px', fontSize:'0.75rem', fontWeight:500 }}>
        {significance}
      </div>
    )}
  </div>;
}

function DataTab({ text }) {
  const findings = useMemo(() => parseFindings(text), [text]);
  if (!findings.length) return <p style={{ color:'#9CA3AF', textAlign:'center', padding:48, fontSize: '0.875rem' }}>No quantitative artifacts retrieved.</p>;
  return <div className="grid-auto fade-in">
    {findings.map((f, i) => <FindingCard key={i} {...f}/>)}
  </div>;
}

/* Risks tab */
function RiskCard({ riskItem, severity, description, implication }) {
  const c = SEV[severity] || SEV.LOW;
  return <div style={{
    background:c.bg, border:`1px solid ${c.border}`,
    borderRadius:'6px', padding:'16px 20px',
  }}>
    <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:8, flexWrap:'wrap' }}>
      <span style={{
        background:'#fff', border: `1px solid ${c.border}`, color:c.text,
        fontSize:'0.65rem', fontWeight:700, padding:'2px 8px',
        borderRadius:'4px', letterSpacing:'0.05em', textTransform:'uppercase',
      }}>{severity}</span>
      <span style={{ fontWeight:600, fontSize:'0.875rem', color:c.text, display: 'flex', alignItems: 'center', gap: 6 }}>{c.icon} {riskItem}</span>
    </div>
    <p style={{ fontSize:'0.875rem', color:'#374151', lineHeight:1.6, marginBottom: 8 }}>{description}</p>
    {implication && <p style={{ fontSize:'0.8125rem', color:c.text, opacity: 0.8, lineHeight:1.5 }}>
      <strong>Implication:</strong> {implication}
    </p>}
  </div>;
}

function RisksTab({ text, meta }) {
  const risks = useMemo(() => parseRisks(text), [text]);
  return <div className="fade-in">
    <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginBottom:20 }}>
      {meta.criticalRiskCount > 0 && <span style={{ background:'#FEF2F2', border: '1px solid #FCA5A5', color:'#991B1B', borderRadius:'4px', padding:'4px 12px', fontSize:'0.75rem', fontWeight:600 }}>{meta.criticalRiskCount} Critical</span>}
      {meta.highRiskCount     > 0 && <span style={{ background:'#FFF7ED', border: '1px solid #FDBA74', color:'#9A3412', borderRadius:'4px', padding:'4px 12px', fontSize:'0.75rem', fontWeight:600 }}>{meta.highRiskCount} High</span>}
      {meta.mediumRiskCount   > 0 && <span style={{ background:'#FFFBEB', border: '1px solid #FDE68A', color:'#B45309', borderRadius:'4px', padding:'4px 12px', fontSize:'0.75rem', fontWeight:600 }}>{meta.mediumRiskCount} Medium</span>}
    </div>
    {risks.length
      ? <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
          {risks.map((r, i) => <RiskCard key={i} {...r}/>)}
        </div>
      : <p style={{ color:'#9CA3AF', textAlign:'center', padding:48, fontSize: '0.875rem' }}>No limitation records extracted.</p>
    }
  </div>;
}

/* Reco tab */
function RecoCard({ recommendation, patientProfile, dosage, monitoring, contraindication, evidenceStrength }) {
  const ev = EV[evidenceStrength] || EV.WEAK;
  return <div style={{
    background:'#fff', border:'1px solid #E5E7EB',
    borderRadius:'6px', padding:20,
  }}>
    <div style={{ fontWeight:600, fontSize:'0.875rem', color:'#111827', marginBottom:16, lineHeight:1.5 }}>{recommendation}</div>
    <div className="reco-inner" style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'12px 24px', fontSize:'0.8125rem' }}>
      {[['Target Patient Profile',patientProfile],['Dosage Parameters',dosage],['Monitoring Req',monitoring],['Contraindications',contraindication]].map(([lbl, val]) => (
        <div key={lbl} style={{display: 'flex', flexDirection: 'column', gap: 4}}>
          <div style={{ color:'#6B7280', fontWeight:600, fontSize: '0.7rem', textTransform: 'uppercase' }}>{lbl}</div>
          <div style={{ color:'#111827', lineHeight:1.5 }}>{val || 'None recorded'}</div>
        </div>
      ))}
    </div>
    <div style={{marginTop: 16, borderTop: '1px solid #F3F4F6', paddingTop: 12}}>
      <span style={{
        display:'inline-block',
        background:ev.bg, color:ev.color, border:`1px solid ${ev.border}`,
        fontSize:'0.65rem', fontWeight:700, padding:'2px 8px',
        borderRadius:'4px', letterSpacing:'0.04em', textTransform:'uppercase',
      }}>{evidenceStrength || 'UNDEFINED'} EVIDENCE</span>
    </div>
  </div>;
}

function RecoTab({ text }) {
  const recos = useMemo(() => parseRecos(text), [text]);
  if (!recos.length) return <p style={{ color:'#9CA3AF', textAlign:'center', padding:48, fontSize: '0.875rem' }}>No protocols established.</p>;
  return <div className="fade-in" style={{ display:'flex', flexDirection:'column', gap:12 }}>
    {recos.map((r, i) => <RecoCard key={i} {...r}/>)}
  </div>;
}

/* Tab bar */
const TABS = [
  { id:'verdict', label:'Overview Synthesis' },
  { id:'data',    label:'Quantitative Metrics'  },
  { id:'risks',   label:'Risk & Limitations'   },
  { id:'reco',    label:'Protocol Guidance' },
];

function TabBar({ active, onChange }) {
  return <div style={{ borderBottom:'1px solid #E5E7EB', marginBottom:24, display:'flex', gap:0, overflowX: 'auto' }}>
    {TABS.map(t => (
      <button key={t.id}
        onClick={() => onChange(t.id)}
        style={{
          background:'none', border:'none',
          padding:'12px 16px', fontSize:'0.875rem',
          fontWeight: active===t.id ? 600 : 500,
          color: active===t.id ? '#0F172A' : '#6B7280',
          cursor:'pointer', transition:'all .15s',
          borderBottom: active===t.id ? '2px solid #0F172A' : '2px solid transparent',
          marginBottom: '-1px'
        }}
      >{t.label}</button>
    ))}
  </div>;
}

/* Clinical Summary */
function ClinicalSummary({ result }) {
  const [tab, setTab] = useState('verdict');
  const syn = useMemo(() => parseSynthesis(result.synthesis), [result.synthesis]);

  return <Card className="fade-in" style={{ padding:28 }}>
    <SectionTitle title="Clinical Digest" sub="Aggregated output from all agents, synthesized for a physician context."/>
    <TabBar active={tab} onChange={setTab}/>
    {tab === 'verdict' && <VerdictTab syn={syn}/>}
    {tab === 'data'    && <DataTab    text={result.agents?.extractor}/>}
    {tab === 'risks'   && <RisksTab   text={result.agents?.risk} meta={result.meta||{}}/>}
    {tab === 'reco'    && <RecoTab    text={result.agents?.recommendation}/>}
  </Card>;
}

/* ─── App root ──────────────────────────────────────────────────────────── */

const INIT_STEPS = STEP_LABELS.map(() => ({ status:'idle', detail:'' }));

function App() {
  const [phase, setPhase]   = useState('idle'); 
  const [steps, setSteps]   = useState(INIT_STEPS);
  const [result, setResult] = useState(null);

  function patchStep(i, patch) {
    setSteps(prev => prev.map((s, idx) => idx === i ? { ...s, ...patch } : s));
  }

  async function handleAnalyze({ file, text }) {
    setPhase('loading');
    setSteps(INIT_STEPS);
    setResult(null);

    const fd = new FormData();
    if (file) fd.append('paper', file, file.name);
    else      fd.append('text', text);

    patchStep(0, { status:'loading', detail:'Acquiring baseline text' });
    await delay(480);
    patchStep(0, { status:'pass', detail:'Text acquisition complete' });

    patchStep(1, { status:'loading', detail:'Performing structural validation' });
    await delay(480);

    let data;
    try {
      const resp = await fetch('/api/analyze', { method:'POST', body:fd });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ detail: resp.statusText }));
        throw new Error(err.detail || `Server exception ${resp.status}`);
      }
      data = await resp.json();
    } catch(e) {
      patchStep(1, { status:'fail', detail:'Validation terminated: ' + e.message });
      patchStep(2, { status:'fail', detail:'Suspended' });
      patchStep(3, { status:'fail', detail:'Suspended' });
      setPhase('idle');
      return;
    }

    patchStep(1, { status:'pass', detail:`Format identified: ${data.documentType || 'Unknown'}` });
    await delay(120);

    if (!data.valid) {
      patchStep(2, { status:'fail', detail:'Document criteria mismatch — exception thrown' });
      patchStep(3, { status:'fail', detail:'Suspended' });
      setResult(data); setPhase('rejected');
      return;
    }

    patchStep(2, { status:'pass', detail:'Document validated — pipeline continued' });
    await delay(120);
    patchStep(3, { status:'pass', detail:`Vectorization complete (${data.ragInfo?.totalChunks} segments) · Agents processed data independently` });

    setResult(data); setPhase('complete');
  }

  return <div>
    <Header/>
    <div style={{ maxWidth:1100, margin:'40px auto', padding:'0 24px', display:'flex', flexDirection:'column', gap:32 }}>
      <UploadCard onAnalyze={handleAnalyze} loading={phase === 'loading'}/>

      {phase !== 'idle' && <PipelineSteps steps={steps}/>}

      {phase === 'rejected' && result && <RejectionBanner data={result}/>}

      {phase === 'complete' && result && <>
        <OrchestratorPanel plan={result.orchestratorPlan || {}}/>
        <PaperInfoBar data={result}/>
        <AgentOutputSection agents={result.agents || {}}/>
        <ClinicalSummary result={result}/>
      </>}
    </div>
  </div>;
}

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
