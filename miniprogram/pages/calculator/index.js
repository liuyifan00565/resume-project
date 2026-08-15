const HISTORY_KEY = "calc_history_v1";
const MAX_HISTORY = 30;

function loadHistory() {
  return wx.getStorageSync(HISTORY_KEY) || [];
}
function saveHistory(list) {
  wx.setStorageSync(HISTORY_KEY, list);
}

/**
 * 表达式计算：不使用 eval
 * 支持：
 * - 数字/小数
 * - + - * /
 * - 括号 ()
 * - % 作为“百分号”(x% => x/100)
 * - 一元负号：-3、(-2)
 */
function calcExpression(input) {
  const expr = (input || "").trim();
  if (!expr) return { ok: true, value: 0 };

  const tokens = tokenize(expr);
  const rpn = toRPN(tokens);
  const value = evalRPN(rpn);
  if (!Number.isFinite(value)) return { ok: false, error: "结果无效" };
  return { ok: true, value };
}

function tokenize(expr) {
  const s = expr.replace(/\s+/g, "");
  const tokens = [];
  let i = 0;

  const isDigit = (c) => c >= "0" && c <= "9";

  while (i < s.length) {
    const c = s[i];

    // number
    if (isDigit(c) || c === ".") {
      let j = i;
      let dot = 0;
      while (j < s.length && (isDigit(s[j]) || s[j] === ".")) {
        if (s[j] === ".") dot++;
        if (dot > 1) throw new Error("小数点格式错误");
        j++;
      }
      const numStr = s.slice(i, j);
      if (numStr === ".") throw new Error("数字格式错误");
      tokens.push({ type: "num", value: parseFloat(numStr) });
      i = j;
      continue;
    }

    // operators & parentheses
    if ("+-*/()%".includes(c)) {
      tokens.push({ type: "op", value: c });
      i++;
      continue;
    }

    throw new Error(`不支持字符: ${c}`);
  }

  // 处理一元负号：把它转成 (0 - x)
  const out = [];
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type === "op" && t.value === "-") {
      const prev = out[out.length - 1];
      const isUnary =
        !prev ||
        (prev.type === "op" && prev.value !== ")" && prev.value !== "%") ||
        (prev.type === "op" && prev.value === "(");

      if (isUnary) {
        out.push({ type: "num", value: 0 });
      }
    }
    out.push(t);
  }

  return out;
}

function precedence(op) {
  if (op === "%") return 3; // postfix
  if (op === "*" || op === "/") return 2;
  if (op === "+" || op === "-") return 1;
  return 0;
}

function isLeftAssoc(op) {
  return op !== "%";
}

// Shunting-yard: tokens -> RPN
function toRPN(tokens) {
  const output = [];
  const stack = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    if (t.type === "num") {
      output.push(t);
      continue;
    }

    const op = t.value;

    if (op === "(") {
      stack.push(t);
      continue;
    }

    if (op === ")") {
      while (stack.length && stack[stack.length - 1].value !== "(") {
        output.push(stack.pop());
      }
      if (!stack.length) throw new Error("括号不匹配");
      stack.pop(); // pop '('
      continue;
    }

    // postfix percent
    if (op === "%") {
      output.push(t);
      continue;
    }

    // binary operators
    while (
      stack.length &&
      stack[stack.length - 1].type === "op" &&
      stack[stack.length - 1].value !== "("
    ) {
      const top = stack[stack.length - 1].value;
      if (precedence(op) <= precedence(top)) {
        output.push(stack.pop());
      } else {
        break;
      }
    }
    stack.push(t);
  }

  while (stack.length) {
    const t = stack.pop();
    if (t.value === "(" || t.value === ")") throw new Error("括号不匹配");
    output.push(t);
  }

  return output;
}

function evalRPN(rpn) {
  const st = [];
  for (let i = 0; i < rpn.length; i++) {
    const t = rpn[i];

    if (t.type === "num") {
      st.push(t.value);
      continue;
    }

    const op = t.value;

    if (op === "%") {
      if (st.length < 1) throw new Error("表达式错误");
      const a = st.pop();
      st.push(a / 100);
      continue;
    }

    if (st.length < 2) throw new Error("表达式错误");
    const b = st.pop();
    const a = st.pop();

    let r = 0;
    if (op === "+") r = a + b;
    else if (op === "-") r = a - b;
    else if (op === "*") r = a * b;
    else if (op === "/") {
      if (b === 0) throw new Error("除数不能为0");
      r = a / b;
    } else {
      throw new Error("不支持运算符");
    }
    st.push(r);
  }

  if (st.length !== 1) throw new Error("表达式错误");
  return st[0];
}

function formatNumber(n) {
  if (Object.is(n, -0)) n = 0;
  const s = n.toFixed(10).replace(/\.?0+$/, "");
  return s === "" ? "0" : s;
}

Page({
  data: {
    expr: "",
    resultText: "0",
    errorText: "",
    history: [],

    // 农用工具
    showAgri: false,
    agri: {
      targetSeeds: "",
      tkwg: "",
      germPct: ""
    },
    agriResultText: "",
    agriComputed: "" // 计算出的克数（字符串）
  },
  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({
        selected: 1  // 第1个tab
      })
    }
  },
  onLoad() {
    const history = loadHistory();
    this.setData({ history });
  },

  // —— 顶部按钮 / 跳转 ——
  goHistory() {
    wx.navigateTo({ url: "/pages/history/index" });
  },

  toggleAgri() {
    this.setData({ showAgri: !this.data.showAgri });
  },

  // —— 快捷键 ——
  onQuickMul100() {
    const expr = (this.data.expr || "").trim();
    const next = expr ? `(${expr})*100` : "100";
    this.setData({ expr: next }, this.tryPreview);
  },

  onQuickDiv1000() {
    const expr = (this.data.expr || "").trim();
    const next = expr ? `(${expr})/1000` : "0";
    this.setData({ expr: next }, this.tryPreview);
  },

  // —— 长按 AC：全部清除当前输入 ——
  onClearAll() {
    wx.showModal({
      title: "全部清除？",
      content: "将清空当前计算内容",
      success: (res) => {
        if (res.confirm) {
          this.setData({ expr: "", resultText: "0", errorText: "" });
          if (wx.vibrateShort) wx.vibrateShort();
        }
      }
    });
  },

  // —— 农用工具输入/计算 ——
  onAgriInput(e) {
    const k = e.currentTarget.dataset.k;
    const v = e.detail.value;
    const agri = this.data.agri || {};
    agri[k] = v;
    this.setData({ agri });
  },

  onAgriCalc() {
    const a = this.data.agri || {};
    const targetSeeds = parseFloat(a.targetSeeds);
    const tkwg = parseFloat(a.tkwg);
    const germPct = parseFloat(a.germPct);

    if (!Number.isFinite(targetSeeds) || !Number.isFinite(tkwg) || !Number.isFinite(germPct)) {
      this.setData({ agriResultText: "请把三个输入都填完整（数字）" });
      return;
    }
    if (tkwg <= 0 || germPct <= 0) {
      this.setData({ agriResultText: "千粒重/发芽率必须大于 0" });
      return;
    }

    const needSeeds = targetSeeds / (germPct / 100);
    const grams = needSeeds * (tkwg / 1000);
    const kg = grams / 1000;

    const gramsStr = grams.toFixed(2);
    const text = `需播约 ${Math.round(needSeeds)} 粒，约 ${gramsStr} g（${kg.toFixed(3)} kg）`;
    this.setData({ agriResultText: text, agriComputed: gramsStr });
  },

  onAgriUseResult() {
    const grams = this.data.agriComputed;
    if (!grams) {
      this.setData({ agriResultText: "请先点“计算”得到结果" });
      return;
    }

    // 如果当前表达式末尾是数字或 ')' 或 '%'，默认用 “+” 连接更安全
    const expr = (this.data.expr || "").trim();
    const last = expr.slice(-1);
    const needPlus = expr && (("0123456789.)%".indexOf(last) !== -1));
    const next = expr ? (needPlus ? `${expr}+${grams}` : `${expr}${grams}`) : `${grams}`;

    this.setData({ expr: next }, this.tryPreview);
  },

  // —— 原有按键输入逻辑 ——
  onInsert(e) {
    const v = e.currentTarget.dataset.v;
    let expr = this.data.expr || "";

    if (!expr && ("*/)%".includes(v))) {
      if (wx.vibrateShort) wx.vibrateShort();
      return;
    }

    const last = expr.slice(-1);
    const ops = "+-*/";
    if (ops.includes(last) && ops.includes(v)) {
      expr = expr.slice(0, -1) + v;
    } else {
      expr += v;
    }

    this.setData({ expr }, this.tryPreview);
  },

  onBackspace() {
    const expr = (this.data.expr || "").slice(0, -1);
    this.setData({ expr }, this.tryPreview);
  },

  onClear() {
    this.setData({ expr: "", resultText: "0", errorText: "" });
  },

  tryPreview() {
    const expr = this.data.expr || "";
    if (!expr) {
      this.setData({ resultText: "0", errorText: "" });
      return;
    }

    try {
      const r = calcExpression(expr);
      if (r.ok) {
        this.setData({ resultText: formatNumber(r.value), errorText: "" });
      } else {
        this.setData({ errorText: r.error || "表达式错误" });
      }
    } catch (err) {
      this.setData({ errorText: (err && err.message) || "表达式错误" });
    }
  },

  onEqual() {
    const expr = (this.data.expr || "").trim();
    if (!expr) return;

    try {
      const r = calcExpression(expr);
      if (!r.ok) {
        this.setData({ errorText: r.error || "表达式错误" });
        return;
      }

      const resText = formatNumber(r.value);
      const ts = Date.now();
      const item = {
        id: `${ts}_${Math.random().toString(16).slice(2)}`,
        ts,
        expr,
        res: resText
      };

      const history = [item, ...loadHistory()].slice(0, MAX_HISTORY);
      saveHistory(history);

      this.setData({ resultText: resText, expr: resText, errorText: "", history });
      if (wx.vibrateShort) wx.vibrateShort();
    } catch (err) {
      this.setData({ errorText: (err && err.message) || "表达式错误" });
    }
  },

  // 这两个你现在计算器页 UI 可能用不到（历史已独立页面），保留也不影响
  onClearHistory() {
    wx.showModal({
      title: "清空历史？",
      content: "清空后不可恢复",
      success: (res) => {
        if (res.confirm) {
          saveHistory([]);
          this.setData({ history: [] });
        }
      }
    });
  },

  onPickHistory(e) {
    const expr = e.currentTarget.dataset.expr || "";
    this.setData({ expr }, this.tryPreview);
  }
});

