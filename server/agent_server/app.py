# 考种智能体 Agent Server
# FastAPI + LangGraph  port 8002
# 部署到 /root/anaconda3/envs/python3/bin/uvicorn main:app --host 0.0.0.0 --port 8002

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, List, Any
from langgraph.graph import StateGraph, END
from langchain_anthropic import ChatAnthropic
from langchain_core.messages import HumanMessage, AIMessage, SystemMessage
from typing import TypedDict
import os, json

app = FastAPI(title="考种智能体")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ── LLM ──────────────────────────────────────────────
llm = ChatAnthropic(
    model="claude-sonnet-4-6",
    api_key=os.environ.get("ANTHROPIC_API_KEY", ""),
    max_tokens=2000,
)

# ── State ─────────────────────────────────────────────
class AgentState(TypedDict):
    question: str
    history: List[dict]
    local_data: dict
    intent: str          # "data_query" | "general"
    fetched_data: str
    response: str

# ── Node 1: 意图路由 ──────────────────────────────────
DATA_KEYWORDS = [
    "株高", "穗长", "茎节", "分蘖", "底荚",
    "测量", "数据", "历史", "记录", "称重", "重量",
    "计数", "合格率", "标签", "趋势", "均值", "平均",
    "最高", "最低", "对比", "怎么样", "分析我", "查看",
]

def node_router(state: AgentState) -> AgentState:
    q = state["question"]
    has_data = bool(state.get("local_data"))
    is_data_q = any(kw in q for kw in DATA_KEYWORDS)
    intent = "data_query" if (is_data_q and has_data) else "general"
    return {**state, "intent": intent}

# ── Node 2: 数据提取（把本地存储整理成自然语言上下文）─────
def node_fetch_data(state: AgentState) -> AgentState:
    d = state.get("local_data", {})
    parts = []

    # 测量记录
    measurements = d.get("measurements", [])
    if measurements:
        parts.append(f"【考种测量记录】共 {len(measurements)} 次：")
        for e in measurements[:6]:
            rs = "、".join(f"{r['type']} {r['cm']}cm" for r in e.get("results", []))
            parts.append(f"  {e.get('displayTime','')}  {rs}")

    # 标签记录
    tags = d.get("tags", [])
    if tags:
        parts.append(f"\n【标签记录】共 {len(tags)} 条：")
        for t in tags[:5]:
            parts.append(f"  {t.get('displayTime','')}  {t.get('summaryTitle','')}  {t.get('summarySub','')}")

    # 计数历史
    counts = d.get("seedCounts", [])
    if counts:
        parts.append(f"\n【籽粒计数历史】最近 {min(3,len(counts))} 次：")
        for c in counts[:3]:
            parts.append(f"  {c.get('displayTime','')}  {c.get('totalCount','?')} 粒  合格率 {c.get('passRatePct','?')}%")

    # 称重
    weight = d.get("latestWeight")
    if weight is not None:
        parts.append(f"\n【最新称重】{weight} g")

    fetched = "\n".join(parts) if parts else ""
    return {**state, "fetched_data": fetched}

# ── Node 3: LLM 分析 ──────────────────────────────────
SYSTEM_BASE = """你是考种智能体AI助手，专注于农业育种数据分析。
你能帮助用户分析种子计数、称重、株高等农艺性状数据，提供专业育种建议。
回答用中文，简洁专业，必要时用数据支撑结论。"""

def node_analyze(state: AgentState) -> AgentState:
    system_content = SYSTEM_BASE
    if state.get("fetched_data"):
        system_content += f"\n\n以下是用户的真实采集数据，请基于此回答：\n{state['fetched_data']}"

    msgs = [SystemMessage(content=system_content)]

    # 历史消息（最近 10 条）
    for m in (state.get("history") or [])[-10:]:
        role, content = m.get("role",""), m.get("content","")
        if not content:
            continue
        if isinstance(content, list):          # 图片消息只取文本部分
            text = " ".join(c.get("text","") for c in content if isinstance(c, dict))
            content = text
        if role == "user":
            msgs.append(HumanMessage(content=str(content)))
        elif role == "assistant":
            msgs.append(AIMessage(content=str(content)))

    msgs.append(HumanMessage(content=state["question"]))
    result = llm.invoke(msgs)
    return {**state, "response": result.content}

# ── 构建 LangGraph ────────────────────────────────────
def build_graph():
    g = StateGraph(AgentState)
    g.add_node("router",     node_router)
    g.add_node("fetch_data", node_fetch_data)
    g.add_node("analyze",    node_analyze)

    g.set_entry_point("router")
    g.add_conditional_edges(
        "router",
        lambda s: s["intent"],
        {"data_query": "fetch_data", "general": "analyze"},
    )
    g.add_edge("fetch_data", "analyze")
    g.add_edge("analyze", END)
    return g.compile()

agent = build_graph()

# ── 报告生成图（用于 describe_report 页）────────────────
class ReportState(TypedDict):
    raw_data: dict
    stats: dict
    analysis: str
    report_md: str

def node_stats(state: ReportState) -> ReportState:
    import statistics
    data = state["raw_data"]
    heights = [float(r["cm"]) for entry in data.get("measurements",[])
               for r in entry.get("results",[]) if r.get("type") == "株高"]
    spikes  = [float(r["cm"]) for entry in data.get("measurements",[])
               for r in entry.get("results",[]) if r.get("type") == "穗长"]
    return {**state, "stats": {
        "height_count": len(heights),
        "height_mean":  round(statistics.mean(heights), 2) if heights else None,
        "height_stdev": round(statistics.stdev(heights), 2) if len(heights)>1 else 0,
        "spike_mean":   round(statistics.mean(spikes), 2) if spikes else None,
        "seed_count":   data.get("seed_count", 0),
        "avg_weight":   data.get("avg_weight", 0),
        "pass_rate":    data.get("pass_rate"),
    }}

def node_report_llm(state: ReportState) -> ReportState:
    s = state["stats"]
    prompt = f"""你是农业育种专家，根据以下考种数据给出专业分析报告：
株高：{s['height_mean']} cm（n={s['height_count']}，标准差 {s['height_stdev']}）
穗长：{s['spike_mean']} cm
籽粒计数：{s['seed_count']} 粒
平均粒重：{s['avg_weight']} g
质检合格率：{s['pass_rate']}%

请输出：① 数据异常点  ② 产量潜力评估  ③ 改进建议。中文，300字以内。"""
    result = llm.invoke([HumanMessage(content=prompt)])
    return {**state, "analysis": result.content}

def node_format_report(state: ReportState) -> ReportState:
    s, a = state["stats"], state["analysis"]
    md = f"""# 考种智能分析报告

## 基础数据
| 指标 | 数值 |
|------|------|
| 籽粒计数 | {s['seed_count']} 粒 |
| 平均株高 | {s['height_mean']} cm（±{s['height_stdev']}） |
| 平均穗长 | {s['spike_mean']} cm |
| 平均粒重 | {s['avg_weight']} g |
| 质检合格率 | {s['pass_rate']}% |

## 智能分析
{a}

---
*由考种智能体自动生成*"""
    return {**state, "report_md": md}

def build_report_graph():
    g = StateGraph(ReportState)
    g.add_node("stats",  node_stats)
    g.add_node("llm",    node_report_llm)
    g.add_node("format", node_format_report)
    g.set_entry_point("stats")
    g.add_edge("stats",  "llm")
    g.add_edge("llm",    "format")
    g.add_edge("format", END)
    return g.compile()

report_agent = build_report_graph()

# ── HTTP 接口 ─────────────────────────────────────────
class ChatRequest(BaseModel):
    question: Optional[str] = ""
    input:    Optional[str] = ""       # 兼容旧字段名
    history:  Optional[List[dict]] = []
    localData: Optional[dict] = {}

class ChatV2Request(BaseModel):
    session_id: Optional[str] = ""
    message:    Optional[str] = ""
    image:      Optional[str] = None   # base64 data URL 或 https:// URL

class ReportRequest(BaseModel):
    measurements: Optional[List[dict]] = []
    seed_count:   Optional[int] = 0
    avg_weight:   Optional[float] = 0
    pass_rate:    Optional[float] = None

@app.get("/health")
def health():
    return {"status": "ok", "service": "考种智能体", "port": 8002}

@app.post("/chat")
def chat_v2(req: ChatV2Request):
    """
    供小程序 AI 助手调用的多模态接口。
    image 字段接受两种形式：
      1. base64 data URL：data:image/jpeg;base64,/9j/4AAQ...
      2. 公开可访问的 https:// URL
    不再要求客户端传微信云存储 tempFileURL（该 URL 外部服务无法下载）。
    """
    question = (req.message or "").strip()
    if not question and not req.image:
        return {"reply": "消息不能为空"}

    try:
        msgs = [SystemMessage(content=SYSTEM_BASE)]

        if req.image:
            img_str = req.image.strip()
            if img_str.startswith("data:image"):
                # base64 data URL → 拆出 media_type 和 data
                header, b64_data = img_str.split(",", 1)
                media_type = header.split(";")[0].split(":")[1]  # e.g. "image/jpeg"
                image_block = {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": media_type,
                        "data": b64_data,
                    },
                }
            else:
                # 公开 URL（如 https://...）
                image_block = {
                    "type": "image",
                    "source": {"type": "url", "url": img_str},
                }
            msgs.append(HumanMessage(content=[
                image_block,
                {"type": "text", "text": question or "请分析这张图片"},
            ]))
        else:
            msgs.append(HumanMessage(content=question))

        result = llm.invoke(msgs)
        return {"reply": result.content, "image_base64": ""}
    except Exception as e:
        import traceback; traceback.print_exc()
        return {"reply": f"分析失败：{e}"}


@app.post("/ai_chat")
def ai_chat(req: ChatRequest):
    question = (req.question or req.input or "").strip()
    if not question:
        return {"ok": False, "text": "问题不能为空"}
    try:
        result = agent.invoke({
            "question":    question,
            "history":     req.history or [],
            "local_data":  req.localData or {},
            "intent":      "general",
            "fetched_data": "",
            "response":    "",
        })
        return {
            "ok":       True,
            "text":     result["response"],
            "intent":   result.get("intent", "general"),
            "has_data": bool(result.get("fetched_data")),
        }
    except Exception as e:
        return {"ok": False, "text": f"Agent 异常：{e}"}

@app.post("/generate_report")
def generate_report(req: ReportRequest):
    try:
        result = report_agent.invoke({
            "raw_data": {
                "measurements": req.measurements,
                "seed_count":   req.seed_count,
                "avg_weight":   req.avg_weight,
                "pass_rate":    req.pass_rate,
            },
            "stats": {}, "analysis": "", "report_md": "",
        })
        return {"ok": True, "report_md": result["report_md"]}
    except Exception as e:
        return {"ok": False, "report_md": f"生成失败：{e}"}
