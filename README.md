# Medical Research Summarizer (Multi-Agent Orchestrator)

The **Medical Research Summarizer** is an advanced AI-powered web application that automates the analysis of dense medical and scientific research papers. Built utilizing an **Orchestrator-Agent Architecture**, this tool reads clinical trials, meta-analyses, and pharmacological studies, synthesizes the findings using specialized AI agents, and distills the data into an actionable "Clinical Digest" for physicians.

## 🏗 System Architecture

The application demonstrates a **Planning & Delegation (Plan-and-Execute)** orchestrator pattern. 

1. **The Orchestrator:** The backend initially scans the document to contextually understand the paper (e.g., identifying the drug, disease, and study type). It then dynamically crafts three *highly customized* task prompts tailored to that specific context.
2. **Parallel Specialist Agents:**
   - **Agent 1 (Clinical Data Extractor):** Focuses solely on extracting quantitative metrics (trial results, sample sizes, p-values, dosages).
   - **Agent 2 (Risk & Limitations Analyzer):** Focuses solely on patient safety (adverse events, contraindications, study biases, missing controls).
   - **Agent 3 (Treatment Guidance Writer):** Focuses solely on translating findings into real-world physician protocols (target patient demographic, dosage schedules, monitoring requirements).
3. **Synthesis Engine:** A final "Chief Medical Officer" AI agent receives the reports from all three specialists, resolves conflicts, removes duplicates, and outputs a highly structured clinical digest with a final verdict (e.g., *STRONG EVIDENCE*).
4. **Retrieval-Augmented Generation (RAG):** Under the hood, the system chunks the PDF/text, embeds it with OpenAI's `text-embedding-3-small`, and stores it in an in-memory ChromaDB instance to ensure the agents perfectly recall the context.

## 🚀 Tech Stack

- **Backend:** Python, FastAPI, Uvicorn
- **Frontend:** React (via Babel standalone), HTML5, CSS3, SVG (Custom crafted UI)
- **AI/LLM:** OpenAI API (GPT-4o)
- **RAG Component:** ChromaDB

---

## ⚙️ How to Run Locally

Because the static React frontend is natively mounted to the FastAPI backend, **you do not need a separate frontend server (like Node or Vite)**. The entire app runs from a single Python command.

### 1. Prerequisites
- Python 3.10+
- An OpenAI API Key

### 2. Setup environment variables
Make sure you have a `.env` file in the root directory (alongside `server.py`) containing your OpenAI key:
```env
OPENAI_API_KEY=sk-your_api_key_here
```

### 3. Install Dependencies
Open a terminal in the project directory and install the required Python packages:
```bash
pip install -r requirements.txt
```

### 4. Start the Application
Run the FastAPI backend server:
```bash
python server.py
```

### 5. Access the App
Open your web browser and navigate to:
**http://localhost:8000**
