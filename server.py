import os
import re
import uuid
import asyncio
import logging
from pathlib import Path
from typing import Optional

import chromadb
from dotenv import load_dotenv
from fastapi import FastAPI, File, UploadFile, Form, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse
from openai import AsyncOpenAI
import pypdf

load_dotenv()
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("medical-summarizer")

openai_client = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))
chroma_client = chromadb.EphemeralClient()
app = FastAPI(title="Medical Research Summarizer")
PUBLIC_DIR = Path(__file__).parent / "public"
EMBEDDING_MODEL = "text-embedding-3-small"

# ---------------------------------------------------------------------------
# RECURSIVE CHUNKER
# ---------------------------------------------------------------------------

class RecursiveChunker:
    def __init__(self, max_chunk_size: int = 1500, overlap: int = 300):
        self.max_chunk_size = max_chunk_size
        self.overlap = overlap
        self.separators = ["\n\n\n", "\n\n", "\n", ". ", ", ", " "]

    def chunk(self, text: str) -> list[dict]:
        # Normalize line endings and tabs
        cleaned = text.replace("\r\n", "\n").replace("\r", "\n").replace("\t", "    ")
        cleaned = cleaned.strip()

        if len(cleaned) <= self.max_chunk_size:
            return [{"text": cleaned, "index": 0, "start": 0, "end": len(cleaned), "has_overlap": False}]

        raw_chunks = self._recursive_split(cleaned, list(self.separators))

        # Add overlap: for each chunk i > 0, prepend last `overlap` chars of chunk i-1
        final_chunks = []
        for i, c in enumerate(raw_chunks):
            if i == 0:
                final_chunks.append({**c, "index": 0, "has_overlap": False})
            else:
                prev_text = raw_chunks[i - 1]["text"]
                overlap_text = prev_text[-self.overlap:] if len(prev_text) > self.overlap else prev_text
                new_text = overlap_text + "\n[CONTINUED FROM PREVIOUS SECTION]\n" + c["text"]
                final_chunks.append({
                    "text": new_text,
                    "index": i,
                    "start": c.get("start", 0),
                    "end": c.get("end", len(c["text"])),
                    "has_overlap": True,
                })

        log.info("Chunking complete: %d chunks from %d chars", len(final_chunks), len(cleaned))
        return final_chunks

    def _recursive_split(self, text: str, separators: list[str]) -> list[dict]:
        # Base case: fits in one chunk
        if len(text) <= self.max_chunk_size:
            return [{"text": text, "start": 0, "end": len(text), "has_overlap": False}]

        # No separators left: force split
        if not separators:
            chunks = []
            pos = 0
            while pos < len(text):
                chunk_text = text[pos: pos + self.max_chunk_size]
                chunks.append({"text": chunk_text, "start": pos, "end": pos + len(chunk_text), "has_overlap": False})
                pos += self.max_chunk_size
            return chunks

        sep = separators[0]
        rest_seps = separators[1:]

        parts = text.split(sep)
        result_chunks = []
        current_bucket = ""

        for part in parts:
            candidate = current_bucket + (sep if current_bucket else "") + part
            if len(candidate) > self.max_chunk_size and current_bucket:
                # Save current bucket — recurse with remaining separators if still too big
                if len(current_bucket) > self.max_chunk_size:
                    result_chunks.extend(self._recursive_split(current_bucket, rest_seps))
                else:
                    result_chunks.append({"text": current_bucket, "start": 0, "end": len(current_bucket), "has_overlap": False})
                current_bucket = part
            else:
                current_bucket = candidate

        # Push final bucket
        if current_bucket:
            if len(current_bucket) > self.max_chunk_size:
                result_chunks.extend(self._recursive_split(current_bucket, rest_seps))
            else:
                result_chunks.append({"text": current_bucket, "start": 0, "end": len(current_bucket), "has_overlap": False})

        return result_chunks


chunker = RecursiveChunker(max_chunk_size=1500, overlap=300)

# ---------------------------------------------------------------------------
# LLM HELPER
# ---------------------------------------------------------------------------

async def call_openai(system_prompt: str, user_message: str, max_tokens: int = 800) -> str:
    log.info("OpenAI call — system: %s...", system_prompt[:60].replace("\n", " "))
    response = await openai_client.chat.completions.create(
        model="gpt-4o",
        temperature=0,
        max_tokens=max_tokens,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user",   "content": user_message},
        ],
    )
    return response.choices[0].message.content.strip()

# ---------------------------------------------------------------------------
# FIELD PARSER HELPER
# ---------------------------------------------------------------------------

def parse_field(text: str, field: str) -> str:
    m = re.search(rf"{field}:\s*([\s\S]+?)(?=\n[A-Z_0-9]+:|$)", text)
    return m.group(1).strip() if m else ""

# ---------------------------------------------------------------------------
# EMBEDDING + CHROMADB HELPERS
# ---------------------------------------------------------------------------

AGENT_QUERIES = {
    "extractor": (
        "clinical trial results statistics sample size efficacy dosage "
        "p-value confidence interval outcomes quantitative data measurements"
    ),
    "risk": (
        "adverse events side effects safety limitations contraindications "
        "bias study weakness what the study does not prove warning signals"
    ),
    "recommendation": (
        "treatment recommendation clinical guidance prescribe dosage patient "
        "selection when to use actionable conclusions therapeutic use"
    ),
}


async def embed_texts(texts: list[str]) -> list[list[float]]:
    log.info("Embedding %d texts with %s", len(texts), EMBEDDING_MODEL)
    response = await openai_client.embeddings.create(model=EMBEDDING_MODEL, input=texts)
    return [item.embedding for item in response.data]


async def embed_and_store(chunks: list[dict]) -> tuple[str, list[list[float]]]:
    """Single batched OpenAI call: embed all chunks + 3 agent queries together."""
    chunk_texts = [c["text"] for c in chunks]
    query_texts = [
        AGENT_QUERIES["extractor"],
        AGENT_QUERIES["risk"],
        AGENT_QUERIES["recommendation"],
    ]

    all_embeddings = await embed_texts(chunk_texts + query_texts)
    chunk_embeddings = all_embeddings[: len(chunks)]
    query_embeddings = all_embeddings[len(chunks):]

    col_name = f"paper_{uuid.uuid4().hex}"
    collection = chroma_client.create_collection(name=col_name)
    collection.add(
        documents=chunk_texts,
        embeddings=chunk_embeddings,
        ids=[f"chunk_{i}" for i in range(len(chunks))],
        metadatas=[
            {"index": i, "has_overlap": chunks[i]["has_overlap"]}
            for i in range(len(chunks))
        ],
    )
    log.info("ChromaDB: stored %d chunks in collection '%s'", len(chunks), col_name)
    return col_name, query_embeddings


def rag_retrieve(col_name: str, query_embeddings: list[list[float]], top_k: int) -> dict[str, list[str]]:
    collection = chroma_client.get_collection(col_name)
    agent_names = ["extractor", "risk", "recommendation"]
    retrieved: dict[str, list[str]] = {}
    for agent, emb in zip(agent_names, query_embeddings):
        results = collection.query(query_embeddings=[emb], n_results=top_k)
        retrieved[agent] = results["documents"][0]
        log.info("RAG %-16s retrieved %d chunks", agent, len(retrieved[agent]))
    return retrieved


def compute_top_k(chunk_count: int) -> int:
    if chunk_count <= 4:
        return chunk_count
    if chunk_count <= 8:
        return max(4, chunk_count // 2 + 1)
    return max(5, int(chunk_count * 0.6))


def cleanup_collection(col_name: str):
    try:
        chroma_client.delete_collection(col_name)
    except Exception:
        pass

# ---------------------------------------------------------------------------
# RESULT MERGER FUNCTIONS
# ---------------------------------------------------------------------------

def normalize_key(name: str) -> str:
    return re.sub(r"[\s\-_.#]+", " ", name.lower()).strip()


def merge_extractor_results(results: list[str]) -> str:
    seen: set[str] = set()
    merged: list[str] = []
    combined = "\n---\n".join(results)
    for block in combined.split("---"):
        block = block.strip()
        if not block:
            continue
        m = re.search(r"FINDING:\s*(.+)", block)
        if not m:
            continue
        key = normalize_key(m.group(1))
        if key in seen:
            continue
        seen.add(key)
        merged.append(block)
    return "\n---\n".join(merged)


def merge_risk_results(results: list[str]) -> str:
    RANK = {"CRITICAL": 4, "HIGH": 3, "MEDIUM": 2, "LOW": 1}
    best: dict[str, tuple[int, str]] = {}
    combined = "\n---\n".join(results)
    for block in combined.split("---"):
        block = block.strip()
        if not block:
            continue
        item_m = re.search(r"RISK_ITEM:\s*(.+)", block)
        sev_m  = re.search(r"SEVERITY:\s*(.+)", block)
        if not item_m or not sev_m:
            continue
        key  = normalize_key(item_m.group(1))
        rank = RANK.get(sev_m.group(1).strip().upper(), 0)
        if key not in best or rank > best[key][0]:
            best[key] = (rank, block)
    return "\n---\n".join(block for _, block in best.values())


def merge_recommendation_results(results: list[str]) -> str:
    seen: set[str] = set()
    merged: list[str] = []
    combined = "\n---\n".join(results)
    for block in combined.split("---"):
        block = block.strip()
        if not block:
            continue
        m = re.search(r"RECOMMENDATION:\s*(.+)", block)
        if not m:
            continue
        key = normalize_key(m.group(1))
        if key in seen:
            continue
        seen.add(key)
        merged.append(block)
    return "\n---\n".join(merged)


def count_severity(risk_text: str, level: str) -> int:
    return len(re.findall(rf"SEVERITY:\s*{level}", risk_text))

# ---------------------------------------------------------------------------
# SYSTEM PROMPTS — FIXED (validation + synthesizer only)
# ---------------------------------------------------------------------------

VALIDATION_SYSTEM = """
You are a strict document validation gateway for a medical research summarizer.
Your ONLY job: decide if this document is a medical or scientific research paper.

VALID: clinical trial, meta-analysis, systematic review, case study, observational
study, pharmacological study, medical journal article, or any peer-reviewed
scientific paper on a medical topic.

INVALID: news articles, blog posts, recipes, legal contracts, resumes, textbooks
without original research, marketing materials, or non-medical content.

Respond ONLY in this exact format:
VALID: [YES or NO]
DOCUMENT_TYPE: [what the document actually is — be specific]
REASON: [one sentence]
MISSING: [if NO — what makes it not a research paper. If YES — write NONE]
""".strip()

SYNTHESIZER_SYSTEM = """
You are a chief medical officer synthesizing findings from 3 specialist agents
into a final clinical summary for a physician audience.

Combine the data findings, risk signals, and treatment recommendations into
one coherent clinical picture. Be precise, evidence-based, and actionable.

Output EXACTLY in this format:
CLINICAL_VERDICT: [one of: STRONG EVIDENCE / MODERATE EVIDENCE / LIMITED EVIDENCE / INSUFFICIENT EVIDENCE]
VERDICT_REASONING: [2-3 sentences explaining the overall quality and strength of evidence]
KEY_FINDING: [the single most important quantitative result from this paper]
PATIENT_POPULATION: [who this evidence applies to — be specific]
RECOMMENDED_ACTION: [what a clinician should DO based on this paper — specific and actionable]
CAUTION: [the most important safety concern or limitation a clinician must know]
STEP_1: [first concrete clinical action]
STEP_2: [second concrete clinical action]
STEP_3: [third concrete clinical action — could be monitoring or follow-up]
PRIORITY_RISK: [the single most important risk finding to communicate to patients]
""".strip()

# ---------------------------------------------------------------------------
# ORCHESTRATOR SYSTEM PROMPT
# ---------------------------------------------------------------------------

ORCHESTRATOR_SYSTEM = """
You are a medical research orchestrator. Your job is to READ this research
paper and generate CUSTOM, SPECIFIC task instructions for 3 specialist agents.

Do NOT write generic instructions. Every instruction must reference the
specific drug, disease, intervention, population, or metric found in THIS paper.

The 3 agents you are briefing:

AGENT 1 — Clinical Data Extractor
Specialty: Quantitative data only. Extracts numbers, statistics, trial results,
dosages, sample sizes, p-values, efficacy percentages, confidence intervals.
Cannot make recommendations or assess risk.

AGENT 2 — Risk & Limitations Analyzer
Specialty: Safety and study integrity only. Finds adverse events, side effects,
contraindications, study design flaws, missing controls, selection bias,
what the study does NOT prove, and patient safety signals.
Cannot extract stats or make recommendations.

AGENT 3 — Treatment Recommendation Writer
Specialty: Clinical synthesis only. Turns findings into actionable guidance
for physicians — when to use the treatment, for which patients, at what dose,
what to monitor, what to avoid.
Cannot extract raw data or analyze study limitations.

Output EXACTLY in this format — be SPECIFIC to this paper, not generic:

PAPER_TYPE: [RCT / Meta-Analysis / Observational / Case Study / Systematic Review / Other]
DISEASE_OR_DRUG: [primary subject of this paper — drug name, disease, intervention]
STUDY_DESIGN_SUMMARY: [1 sentence: what this study did, in whom, for how long]
KEY_SECTIONS_FOUND: [list sections visible: Abstract / Methods / Results / Discussion / etc.]

AGENT_1_TASK: [Custom instruction for the data extractor. Name the specific drug/disease.
Specify which exact metrics to extract — e.g. "Extract the primary endpoint HbA1c reduction
at 12 weeks, the sample size per arm, the p-value for the primary endpoint, and any
secondary efficacy endpoints reported for semaglutide vs placebo in T2D patients."]

AGENT_2_TASK: [Custom instruction for the risk analyzer. Name specific adverse events
mentioned. Specify which limitations to look for — e.g. "Identify all adverse events
reported for semaglutide including GI events, cardiovascular signals, and withdrawal rates.
Assess the open-label design limitation and the exclusion of patients with eGFR < 30."]

AGENT_3_TASK: [Custom instruction for the recommendation writer. Specify what clinical
guidance to produce — e.g. "Write prescribing guidance for semaglutide in T2D patients
with HbA1c > 8% who have failed metformin. Include starting dose, titration schedule,
monitoring requirements, and which patient subgroups showed the strongest benefit."]
""".strip()

# ---------------------------------------------------------------------------
# AGENT WRAPPER SYSTEM PROMPTS (built from orchestrator custom tasks)
# ---------------------------------------------------------------------------

def build_extractor_system(custom_task: str) -> str:
    return f"""You are a clinical data extraction specialist.
Your specific task for this paper has been assigned by the orchestrator:

{custom_task}

For each data point or finding you extract output EXACTLY:
FINDING: [the metric or data point name]
VALUE: [the exact number, percentage, or measurement]
CONTEXT: [which group/arm/timepoint this applies to — one sentence]
SIGNIFICANCE: [p-value or confidence interval if reported, else write NOT REPORTED]
---
Separate each finding with ---
If this chunk is a continuation, only extract NEW findings not already covered.
Facts and numbers only — no interpretation, no recommendations."""


def build_risk_system(custom_task: str) -> str:
    return f"""You are a medical safety and limitations analyst.
Your specific task for this paper has been assigned by the orchestrator:

{custom_task}

SEVERITY RUBRIC — apply strictly:
  CRITICAL → Patient safety risk, serious adverse events,
              black box warning territory, or fatal outcomes reported
  HIGH     → Significant adverse events, major study flaw that
              invalidates key conclusions, important contraindication
  MEDIUM   → Moderate adverse events, notable study limitation,
              selection bias that narrows applicability
  LOW      → Minor limitation, common tolerable side effect,
              small gap in evidence worth noting

For each issue output EXACTLY:
RISK_ITEM: [name of the adverse event, limitation, or safety signal]
SEVERITY: [CRITICAL/HIGH/MEDIUM/LOW]
DESCRIPTION: [what was found or what is missing — plain language]
CLINICAL_IMPLICATION: [what this means for a clinician using this evidence]
---
Separate each finding with ---
OVERLAP RULE: If marked [CONTINUED FROM PREVIOUS SECTION],
ignore text before that marker. Only analyze new content after it.
Do not manufacture findings — only report what is actually present."""


def build_recommendation_system(custom_task: str) -> str:
    return f"""You are a clinical treatment guidance specialist.
Your specific task for this paper has been assigned by the orchestrator:

{custom_task}

For each treatment recommendation you produce output EXACTLY:
RECOMMENDATION: [the clinical action or guidance — one clear statement]
PATIENT_PROFILE: [which specific patients this applies to]
DOSAGE_OR_PROTOCOL: [specific dose, frequency, duration if reported — else write REFER TO STUDY]
MONITORING: [what to monitor in these patients]
CONTRAINDICATION: [who should NOT receive this treatment based on this paper]
EVIDENCE_STRENGTH: [STRONG / MODERATE / WEAK — based on study design and sample size]
---
Separate each recommendation with ---
Synthesize from the paper — do not invent data not present in the text.
Write for a physician audience — clinical, specific, actionable."""

# ---------------------------------------------------------------------------
# SAMPLE PAPER TEXT
# ---------------------------------------------------------------------------

SAMPLE_PAPER = """RANDOMIZED CONTROLLED TRIAL: Semaglutide 2.4mg vs Placebo in Adults with Type 2 Diabetes and Obesity

ABSTRACT
This phase 3 RCT evaluated weekly subcutaneous semaglutide 2.4mg versus placebo in 803 adults with T2D and BMI ≥27. Primary endpoint: HbA1c reduction at 68 weeks. Secondary endpoints: body weight reduction, fasting glucose, MACE events.

METHODS
Multicenter double-blind RCT. 803 patients randomized 1:1. Inclusion: T2D diagnosis ≥6 months, HbA1c 7.5–10.5%, stable metformin. Exclusion: eGFR <30, recent cardiovascular event <90 days, proliferative retinopathy. Duration: 68 weeks. Run-in: 4 weeks diet and exercise counseling.

RESULTS
Primary endpoint: Semaglutide reduced HbA1c by 2.1% vs 0.4% for placebo (difference -1.7%, 95% CI -2.0 to -1.4, p<0.001). Body weight: -11.6% semaglutide vs -2.4% placebo (p<0.001). Fasting glucose: -58 mg/dL vs -11 mg/dL. MACE events: 3.2% semaglutide vs 3.8% placebo (HR 0.84, 95% CI 0.45-1.56, not significant). Responders (HbA1c <7%): 79% semaglutide vs 31% placebo.

ADVERSE EVENTS
Nausea: 44% semaglutide vs 17% placebo. Vomiting: 24% vs 8%. Diarrhea: 31% vs 13%. Serious adverse events: 9.8% vs 11.2% (similar). Discontinuation due to GI events: 7% semaglutide vs 2% placebo. Gallbladder events: 3.1% vs 1.2% (HR 2.6). No significant difference in pancreatitis. Injection site reactions: 6% vs 4%.

DISCUSSION
Semaglutide 2.4mg demonstrated superior glycemic and weight reduction versus placebo. GI side effects were common but mostly mild-moderate and peaked at week 8. The cardiovascular signal was neutral. Study limitations: open-label extension phase, exclusion of severe renal impairment (eGFR<30), mostly White participants (82%), short follow-up for cardiovascular outcomes. Insulin users were excluded limiting generalizability.

CONCLUSIONS
Semaglutide 2.4mg weekly is effective for T2D patients with obesity on background metformin. Recommend slow dose titration to minimize GI effects. Monitor for gallbladder disease. Not studied in severe CKD."""

# ---------------------------------------------------------------------------
# SAMPLE ENDPOINT
# ---------------------------------------------------------------------------

@app.get("/api/sample")
async def get_sample():
    return JSONResponse(content={"text": SAMPLE_PAPER})

# ---------------------------------------------------------------------------
# ANALYZE ENDPOINT — 7-STEP PIPELINE
# ---------------------------------------------------------------------------

@app.post("/api/analyze")
async def analyze(
    paper: Optional[UploadFile] = File(None),
    text: Optional[str] = Form(None),
):
    # --- EXTRACT TEXT ---
    paper_text = ""

    if paper and paper.filename:
        raw_bytes = await paper.read()
        if paper.filename.lower().endswith(".pdf"):
            try:
                import io
                reader = pypdf.PdfReader(io.BytesIO(raw_bytes))
                pages = []
                for page in reader.pages:
                    extracted = page.extract_text()
                    if extracted:
                        pages.append(extracted)
                paper_text = "\n".join(pages)
            except Exception as e:
                log.error("PDF extraction failed: %s", e)
                raise HTTPException(status_code=400, detail=f"PDF extraction error: {e}")
        else:
            try:
                paper_text = raw_bytes.decode("utf-8")
            except UnicodeDecodeError:
                paper_text = raw_bytes.decode("latin-1")
    elif text:
        paper_text = text

    if not paper_text or not paper_text.strip():
        raise HTTPException(status_code=400, detail="No document content provided.")

    paper_text = paper_text.strip()

    # -----------------------------------------------------------------------
    # STEP 1 — VALIDATION
    # -----------------------------------------------------------------------
    log.info("=" * 60)
    log.info("STEP 1 — Validation")
    log.info("=" * 60)

    validation_result = await call_openai(
        VALIDATION_SYSTEM,
        f"Document content (first 1500 chars):\n{paper_text[:1500]}",
        max_tokens=200,
    )

    is_valid     = parse_field(validation_result, "VALID").upper() == "YES"
    document_type = parse_field(validation_result, "DOCUMENT_TYPE")
    reason        = parse_field(validation_result, "REASON")
    missing       = parse_field(validation_result, "MISSING")

    if not is_valid:
        log.warning("INVALID document — type: %s | reason: %s", document_type, reason)
        return JSONResponse(content={
            "valid": False,
            "documentType": document_type,
            "reason": reason,
            "missing": missing,
        })

    log.info("VALID — type: %s", document_type)

    # -----------------------------------------------------------------------
    # STEP 2 — ORCHESTRATOR PLANNING
    # -----------------------------------------------------------------------
    log.info("=" * 60)
    log.info("STEP 2 — Orchestrator planning (dynamic task generation)")
    log.info("=" * 60)

    orch_result = await call_openai(
        ORCHESTRATOR_SYSTEM,
        f"RESEARCH PAPER CONTENT (first 2000 chars):\n{paper_text[:2000]}",
        max_tokens=600,
    )

    paper_type      = parse_field(orch_result, "PAPER_TYPE")
    disease_or_drug = parse_field(orch_result, "DISEASE_OR_DRUG")
    study_summary   = parse_field(orch_result, "STUDY_DESIGN_SUMMARY")
    agent_1_task    = parse_field(orch_result, "AGENT_1_TASK")
    agent_2_task    = parse_field(orch_result, "AGENT_2_TASK")
    agent_3_task    = parse_field(orch_result, "AGENT_3_TASK")

    log.info("Paper type:      %s", paper_type)
    log.info("Disease/Drug:    %s", disease_or_drug)
    log.info("Study summary:   %s", study_summary)
    log.info("Agent 1 task:    %s", agent_1_task[:120])
    log.info("Agent 2 task:    %s", agent_2_task[:120])
    log.info("Agent 3 task:    %s", agent_3_task[:120])

    # Build dynamic agent system prompts from orchestrator output
    extractor_system      = build_extractor_system(agent_1_task)
    risk_system           = build_risk_system(agent_2_task)
    recommendation_system = build_recommendation_system(agent_3_task)

    # -----------------------------------------------------------------------
    # STEP 3 — RECURSIVE CHUNKING
    # -----------------------------------------------------------------------
    log.info("=" * 60)
    log.info("STEP 3 — Chunking (%d chars)", len(paper_text))
    log.info("=" * 60)

    chunks = chunker.chunk(paper_text)
    chunk_count = len(chunks)
    top_k = compute_top_k(chunk_count)

    for c in chunks:
        log.info("  Chunk %d: %d chars | has_overlap=%s", c["index"], len(c["text"]), c["has_overlap"])

    # -----------------------------------------------------------------------
    # STEP 4 — EMBED + STORE IN CHROMADB (single batched call)
    # -----------------------------------------------------------------------
    log.info("=" * 60)
    log.info("STEP 4 — Embedding %d chunks + 3 agent queries", chunk_count)
    log.info("=" * 60)

    col_name, query_embeddings = await embed_and_store(chunks)

    # -----------------------------------------------------------------------
    # STEP 5 — RAG RETRIEVAL
    # -----------------------------------------------------------------------
    log.info("=" * 60)
    log.info("STEP 5 — RAG retrieval (top_k=%d)", top_k)
    log.info("=" * 60)

    retrieved = rag_retrieve(col_name, query_embeddings, top_k)

    # -----------------------------------------------------------------------
    # STEP 6 — 3 AGENTS IN PARALLEL on RAG-retrieved chunks
    # -----------------------------------------------------------------------
    log.info("=" * 60)
    log.info("STEP 6 — Running 3 agents in parallel on retrieved chunks")
    log.info("=" * 60)

    async def run_agent(agent_name: str, system_prompt: str, max_tokens: int) -> list[str]:
        agent_chunks = retrieved[agent_name]
        total = len(agent_chunks)
        log.info("Agent %-18s processing %d chunks in parallel", agent_name, total)
        tasks = [
            call_openai(
                system_prompt,
                f"RESEARCH PAPER SECTION (chunk {i + 1} of {total}):\n{chunk_text}",
                max_tokens=max_tokens,
            )
            for i, chunk_text in enumerate(agent_chunks)
        ]
        return await asyncio.gather(*tasks)

    # Pass the DYNAMICALLY BUILT system prompts — core of the orchestrator pattern
    extractor_results, risk_results, reco_results = await asyncio.gather(
        run_agent("extractor",       extractor_system,       max_tokens=800),
        run_agent("risk",            risk_system,            max_tokens=800),
        run_agent("recommendation",  recommendation_system,  max_tokens=900),
    )

    cleanup_collection(col_name)

    # --- STEP 6b: MERGE RESULTS ---
    log.info("Merging results from all chunks")
    merged_extractor = merge_extractor_results(list(extractor_results))
    merged_risk      = merge_risk_results(list(risk_results))
    merged_reco      = merge_recommendation_results(list(reco_results))

    critical_count = count_severity(merged_risk, "CRITICAL")
    high_count     = count_severity(merged_risk, "HIGH")
    med_count      = count_severity(merged_risk, "MEDIUM")

    # -----------------------------------------------------------------------
    # STEP 7 — SYNTHESIZER (sequential, runs last)
    # -----------------------------------------------------------------------
    log.info("=" * 60)
    log.info("STEP 7 — Clinical synthesizer")
    log.info("=" * 60)

    synthesis = await call_openai(
        SYNTHESIZER_SYSTEM,
        f"PAPER TYPE: {paper_type}\n"
        f"DISEASE/DRUG: {disease_or_drug}\n"
        f"STUDY SUMMARY: {study_summary}\n\n"
        f"CLINICAL DATA FINDINGS:\n{merged_extractor}\n\n"
        f"RISK & LIMITATIONS:\n{merged_risk}\n\n"
        f"TREATMENT RECOMMENDATIONS:\n{merged_reco}\n\n"
        f"SEVERITY COUNTS: CRITICAL={critical_count} HIGH={high_count} MEDIUM={med_count}",
        max_tokens=600,
    )

    log.info("Analysis complete")

    # -----------------------------------------------------------------------
    # RETURN RESPONSE
    # -----------------------------------------------------------------------
    return JSONResponse(content={
        "valid":         True,
        "documentType":  document_type,
        "paperType":     paper_type,
        "diseaseOrDrug": disease_or_drug,
        "studySummary":  study_summary,
        "orchestratorPlan": {
            "agent1Task": agent_1_task,
            "agent2Task": agent_2_task,
            "agent3Task": agent_3_task,
        },
        "chunkCount": chunk_count,
        "agents": {
            "extractor":      merged_extractor,
            "risk":           merged_risk,
            "recommendation": merged_reco,
        },
        "synthesis": synthesis,
        "meta": {
            "criticalRiskCount": critical_count,
            "highRiskCount":     high_count,
            "mediumRiskCount":   med_count,
        },
        "ragInfo": {
            "embeddingModel": EMBEDDING_MODEL,
            "vectorStore":    "ChromaDB EphemeralClient (in-memory)",
            "totalChunks":    chunk_count,
            "topK":           top_k,
        },
    })

# ---------------------------------------------------------------------------
# SERVE FRONTEND
# ---------------------------------------------------------------------------

app.mount("/", StaticFiles(directory=str(PUBLIC_DIR), html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=True)
